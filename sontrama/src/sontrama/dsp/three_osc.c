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

/* The complete instrument state belongs here in both native and WASM builds. */
#include <stdlib.h>
#include <string.h>
#define VOICE_COUNT 16
#define TABLE_COUNT (5 * 10 * TABLE_SIZE)
static float *common_tables;

typedef struct {
    int active, note, key_down;
    uint64_t serial, age, random;
    int64_t release_age;
    float velocity, release_level, pressure;
    double phases[3][2];
} Voice;
typedef struct {
    Parameters patch;
    Controls controls;
    Voice voices[VOICE_COUNT];
    double common_phase[3], stereo_phase[3];
    float phase_random;
    int rate, sustain;
    uint32_t seed;
    uint64_t serial, clock;
} Osc;

int sontrama_table_count(void) { return TABLE_COUNT; }
void sontrama_install_tables(const float *data) {
    if (!common_tables) common_tables = malloc(TABLE_COUNT * sizeof(float));
    if (common_tables) memcpy(common_tables, data, TABLE_COUNT * sizeof(float));
}
float *sontrama_tables(void) {
    if (common_tables) return common_tables;
    common_tables = calloc(TABLE_COUNT, sizeof(float));
    if (!common_tables) return NULL;
    for (int shape = 0; shape < 5; shape++) {
        for (int power = 0; power < 10; power++) {
            float *table = common_tables + (shape * 10 + power) * TABLE_SIZE;
            for (int h = 1; h <= (1 << power); h++) {
                double a = 0;
                if (shape == 0) a = h == 1 ? 1 : 0;
                else if (shape == 1 && h % 2) a = 8 / (PI * PI) * (((h - 1) / 2) % 2 ? -1 : 1) / (h * h);
                else if (shape == 2 && h % 2) a = 4 / (PI * h);
                else if (shape == 3) a = -2 / (PI * h);
                else if (shape == 4) a = -1.0 / (h * h);
                if (a == 0) continue;
                for (int n = 0; n < TABLE_SIZE; n++)
                    table[n] += (float)(a * sin(2 * PI * h * n / TABLE_SIZE));
            }
        }
    }
    return common_tables;
}
Osc *sontrama_osc_create(int rate, uint32_t seed) {
    if (rate < 8000 || !sontrama_tables()) return NULL;
    Osc *e = calloc(1, sizeof(Osc));
    if (!e) return NULL;
    e->rate = rate; e->seed = seed; e->controls.volume = e->controls.expression = 1;
    return e;
}
void sontrama_osc_free(Osc *e) { free(e); }
void sontrama_osc_configure(Osc *e, const double *p) {
    for (int i = 0; i < 3; i++) {
        const double *v = p + i * 9;
        double common = v[7] / 360, stereo = v[5] / 360;
        for (int n = 0; n < VOICE_COUNT; n++) if (e->voices[n].active) {
            for (int ch = 0; ch < 2; ch++) {
                double delta = common - e->common_phase[i] + (ch ? stereo - e->stereo_phase[i] : 0);
                double phase = fmod(e->voices[n].phases[i][ch] + delta, 1);
                e->voices[n].phases[i][ch] = phase < 0 ? phase + 1 : phase;
            }
        }
        e->common_phase[i] = common; e->stereo_phase[i] = stereo;
        Oscillator *o = &e->patch.oscillators[i];
        o->enabled = (int)v[0]; o->shape = (int)v[1]; o->coarse = (float)v[2];
        o->fine = (float)v[3]; o->pan = (float)v[4]; o->detune = (float)v[6];
    }
    e->patch.mix2 = e->patch.oscillators[1].enabled ? (float)p[17] : 0;
    e->patch.mix3 = e->patch.oscillators[2].enabled ? (float)p[26] : 0;
    e->patch.attack = (float)p[27]; e->patch.decay = (float)p[28];
    e->patch.sustain = (float)p[29]; e->patch.release = (float)p[30];
    e->patch.am = (int)p[31]; e->phase_random = (float)p[32]; e->patch.hq = (int)p[33];
}
static Voice *find_voice(Osc *e, int note) {
    for (int i = 0; i < VOICE_COUNT; i++)
        if (e->voices[i].active && e->voices[i].note == note) return &e->voices[i];
    return NULL;
}
static float voice_level(Osc *e, Voice *v) {
    double t = (double)v->age / e->rate;
    if (t < e->patch.attack) return (float)(t / e->patch.attack);
    if (t < e->patch.attack + e->patch.decay)
        return (float)(1 - (1 - e->patch.sustain) * (t - e->patch.attack) / e->patch.decay);
    return e->patch.sustain;
}
static void release_voice(Osc *e, Voice *v) {
    if (v->release_age < 0) { v->release_level = voice_level(e, v); v->release_age = 0; }
}
void sontrama_osc_panic(Osc *e) {
    memset(e->voices, 0, sizeof(e->voices)); e->sustain = 0; e->controls.bend = 0;
}
void sontrama_osc_midi(Osc *e, int status, int value, int amount) {
    int kind = status & 0xf0;
    Voice *v = find_voice(e, value);
    if (kind == 0x90 && amount) {
        if (!v) for (int i = 0; i < VOICE_COUNT; i++) if (!e->voices[i].active) { v = &e->voices[i]; break; }
        if (!v) { v = &e->voices[0]; for (int i = 1; i < VOICE_COUNT; i++) if (e->voices[i].serial < v->serial) v = &e->voices[i]; }
        memset(v, 0, sizeof(Voice));
        v->active = v->key_down = 1; v->note = value; v->velocity = amount / 127.0f;
        v->release_age = -1; v->serial = ++e->serial;
        v->random = (uint64_t)e->seed ^ (v->serial * UINT64_C(0x9e3779b97f4a7c15));
        if (!v->random) v->random = 1;
        for (int i = 0; i < 3; i++) for (int ch = 0; ch < 2; ch++)
            v->phases[i][ch] = fmod((noise(&v->random) + 1) * .5 * e->phase_random + e->common_phase[i] + (ch ? e->stereo_phase[i] : 0), 1);
    } else if ((kind == 0x80 || kind == 0x90) && v) {
        v->key_down = 0; if (!e->sustain) release_voice(e, v);
    } else if (kind == 0xe0) e->controls.bend = (value + (amount << 7) - 8192) / 8192.0f * 2;
    else if (kind == 0xd0) e->controls.pressure = value / 127.0f;
    else if (kind == 0xa0 && v) v->pressure = amount / 127.0f;
    else if (kind == 0xb0) {
        if (value == 64) {
            e->sustain = amount >= 64;
            if (!e->sustain) for (int i = 0; i < VOICE_COUNT; i++) if (e->voices[i].active && !e->voices[i].key_down) release_voice(e, &e->voices[i]);
        } else if (value == 1) e->controls.modulation = amount / 127.0f;
        else if (value == 7) e->controls.volume = amount / 127.0f;
        else if (value == 11) e->controls.expression = amount / 127.0f;
        else if (value == 10) e->controls.pan = fmaxf(-1, fminf(1, (amount - 64) / 63.0f));
        else if (value == 120) sontrama_osc_panic(e);
        else if (value == 123) {
            for (int i = 0; i < VOICE_COUNT; i++) if (e->voices[i].active) {
                e->voices[i].key_down = 0; if (!e->sustain) release_voice(e, &e->voices[i]);
            }
        } else if (value == 121) {
            memset(&e->controls, 0, sizeof(Controls)); e->controls.volume = e->controls.expression = 1; e->sustain = 0;
            for (int i = 0; i < VOICE_COUNT; i++) if (e->voices[i].active && !e->voices[i].key_down) release_voice(e, &e->voices[i]);
        }
    }
}
void sontrama_osc_process(Osc *e, float *output, int frames) {
    memset(output, 0, frames * 2 * sizeof(float));
    /* Fixed scratch chunks also keep random streams independent of host block sizes. */
    for (int offset = 0; offset < frames; offset += 128) {
        int count = frames - offset < 128 ? frames - offset : 128;
        float lfo[128]; sontrama_fill_lfo(lfo, count, e->rate, e->clock);
        for (int i = 0; i < VOICE_COUNT; i++) if (e->voices[i].active) {
            Voice *v = &e->voices[i];
            sontrama_render_voice(output + offset * 2, &v->phases[0][0], common_tables, &e->patch, &e->controls,
                count, e->rate, v->note, v->velocity, v->age, v->release_age, v->release_level, v->pressure, lfo, &v->random);
            v->age += count;
            if (v->release_age >= 0) {
                v->release_age += count;
                if (v->release_age >= e->patch.release * e->rate) v->active = 0;
            }
        }
        e->clock += count;
    }
}
int sontrama_osc_voice(Osc *e, int note, double *out) {
    Voice *v = find_voice(e, note); if (!v) return 0;
    for (int i = 0; i < 6; i++) out[i] = v->phases[i / 2][i % 2];
    out[6] = (double)v->age; out[7] = (double)v->release_age; out[8] = v->release_level;
    out[9] = v->pressure; out[10] = v->key_down; out[11] = v->velocity;
    return 1;
}
