#include <math.h>
#include <stdint.h>

#define TABLE_SIZE 2048
#define PI 3.14159265358979323846

typedef struct {
    int enabled, shape;
    float coarse, fine, pan, detune;
} Oscillator;
typedef struct {
    Oscillator oscillators[3];
    float mix2, mix3, attack, decay, sustain, release;
    int am, hq;
} Parameters;
typedef struct {
    float bend, modulation, pressure, volume, expression, pan;
} Controls;

static inline float noise(uint64_t *state) {
    uint64_t value = *state;
    value ^= value << 13;
    value ^= value >> 7;
    value ^= value << 17;
    *state = value;
    return (float)(value >> 40) / 8388608.0f - 1.0f;
}

void sontrama_fill_lfo(float *output, int frames, int sample_rate, uint64_t clock) {
    double phase = fmod(clock * (2.0 * PI * 5.0 / sample_rate), 2.0 * PI);
    double step = 2.0 * PI * 5.0 / sample_rate;
    for (int sample = 0; sample < frames; sample++) {
        output[sample] = sinf((float)phase);
        phase += step;
        if (phase >= 2.0 * PI) phase -= 2.0 * PI;
    }
}

void sontrama_render_voice(
    float *output, double *phases, const float *tables,
    const Parameters *params, const Controls *controls,
    int frames, int sample_rate, int note, float velocity, uint64_t age,
    int64_t release_age, float release_level, float pressure, const float *lfo,
    uint64_t *random_state
) {
    float frequencies[3][2], increments[3][2], pans[3][2];
    const float *waves[3][2];
    float depth = fmaxf(controls->modulation, fmaxf(controls->pressure * .5f, pressure * .5f)) * .5f;
    float mix2 = params->mix2, mix3 = params->mix3;
    int needed[3] = {mix2 < 1.0f, mix2 > 0.0f, mix3 > 0.0f};
    for (int osc = 0; osc < 3; osc++) {
        const Oscillator *spec = &params->oscillators[osc];
        float pan = fmaxf(-1.0f, fminf(1.0f, spec->pan + controls->pan));
        float angle = (pan + 1.0f) * (float)(PI / 4.0);
        pans[osc][0] = cosf(angle);
        pans[osc][1] = sinf(angle);
        needed[osc] &= spec->enabled;
        for (int channel = 0; channel < 2; channel++) {
            float cents = spec->fine + spec->detune * (channel ? .5f : -.5f);
            float frequency = 440.0f * exp2f((note - 69 + spec->coarse + cents / 100.0f + controls->bend) / 12.0f);
            frequencies[osc][channel] = frequency;
            increments[osc][channel] = frequency / sample_rate;
            int power = 9;
            if (params->hq) {
                float maximum = frequency * exp2f(depth / 12.0f);
                int limit = (int)(sample_rate * .49f / maximum);
                power = 0;
                while (power < 9 && (1 << (power + 1)) <= limit) power++;
            }
            int shape = spec->shape < 5 ? spec->shape : 0;
            waves[osc][channel] = tables + (shape * 10 + power) * TABLE_SIZE;
        }
    }
    float scale = .2f * velocity * controls->volume * controls->expression;
    float attack_frames = params->attack * sample_rate;
    float decay_frames = params->decay * sample_rate;
    float release_frames = params->release * sample_rate;
    for (int sample = 0; sample < frames; sample++) {
        float envelope;
        if (release_age >= 0) {
            envelope = release_level * fmaxf(0.0f, 1.0f - (release_age + sample) / release_frames);
        } else {
            float elapsed = (float)(age + sample);
            if (elapsed < attack_frames) envelope = elapsed / attack_frames;
            else if (elapsed < attack_frames + decay_frames)
                envelope = 1.0f - (1.0f - params->sustain) * (elapsed - attack_frames) / decay_frames;
            else envelope = params->sustain;
        }
        float vibrato = 1.0f;
        if (depth > 0.0f) {
            // Vibrato is bounded to half a semitone. The cubic exponential is
            // accurate below 0.001 cent and avoids libm calls per voice/sample.
            float x = lfo[sample] * depth * (float)(0.6931471805599453 / 12.0);
            vibrato = 1.0f + x * (1.0f + x * (.5f + x / 6.0f));
        }
        for (int channel = 0; channel < 2; channel++) {
            float signals[3] = {0, 0, 0};
            for (int osc = 0; osc < 3; osc++) {
                double *phase = phases + osc * 2 + channel;
                float frequency = frequencies[osc][channel] * vibrato;
                if (needed[osc]) {
                    float signal = 0;
                    if (params->oscillators[osc].shape == 5) signal = noise(random_state);
                    else if (frequency < sample_rate * .49f) {
                        float position = (float)(*phase * TABLE_SIZE);
                        int index = (int)position;
                        int first = index & (TABLE_SIZE - 1);
                        float fraction = position - index;
                        const float *wave = waves[osc][channel];
                        signal = wave[first] * (1.0f - fraction)
                            + wave[(first + 1) & (TABLE_SIZE - 1)] * fraction;
                    }
                    signals[osc] = signal * pans[osc][channel];
                }
                // Advance muted oscillators too, preserving phase when their mix rises.
                *phase += increments[osc][channel] * vibrato;
                if (*phase >= 1.0) *phase -= floor(*phase);
            }
            float combined = signals[0] * (1.0f - mix2) + signals[1] * mix2;
            if (params->am) combined *= (1.0f - mix3) + mix3 * (signals[2] + 1.0f) * .5f;
            else combined = combined * (1.0f - mix3) + signals[2] * mix3;
            output[sample * 2 + channel] += combined * envelope * scale;
        }
    }
}
