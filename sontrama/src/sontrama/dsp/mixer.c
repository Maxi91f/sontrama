#include <stdlib.h>
#include <math.h>

typedef struct { double gain, pan, target_gain, target_pan, coefficient; int initialized, muted; } Bus;
Bus *sontrama_bus_create(int rate) {
    Bus *bus = calloc(1, sizeof(Bus));
    if (bus) bus->coefficient = exp(-1.0 / (rate * .01));
    return bus;
}
void sontrama_bus_free(Bus *bus) { free(bus); }
void sontrama_bus_configure(Bus *bus, double gain, double pan, int muted) {
    bus->muted = muted; bus->target_gain = gain; bus->target_pan = pan;
    if (!bus->initialized) { bus->gain = gain; bus->pan = pan; bus->initialized = 1; }
}
void sontrama_bus_process(Bus *bus, const float *input, float *output, int frames) {
    for (int i = 0; i < frames; i++) {
        double left = input[i * 2], right = input[i * 2 + 1], pan = bus->pan;
        if (pan != 0) {
            double angle = fabs(pan) * 1.57079632679489661923;
            if (pan < 0) { left += right * sin(angle); right *= cos(angle); }
            else { right += left * sin(angle); left *= cos(angle); }
        }
        output[i * 2] = (float)(left * (bus->muted ? 0 : bus->gain)); output[i * 2 + 1] = (float)(right * (bus->muted ? 0 : bus->gain));
        bus->gain = bus->target_gain + bus->coefficient * (bus->gain - bus->target_gain);
        bus->pan = bus->target_pan + bus->coefficient * (bus->pan - bus->target_pan);
        if (fabs(bus->gain - bus->target_gain) < 1e-12) bus->gain = bus->target_gain;
        if (fabs(bus->pan - bus->target_pan) < 1e-12) bus->pan = bus->target_pan;
    }
}
void sontrama_clip(const float *input, float *output, int frames) {
    for (int i = 0; i < frames * 2; i++) output[i] = fmaxf(-1, fminf(1, input[i]));
}

#ifndef SONTRAMA_CORE_REVISION
#define SONTRAMA_CORE_REVISION "unversioned"
#endif
const char *sontrama_core_revision(void) { return SONTRAMA_CORE_REVISION; }
