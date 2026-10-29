/* Stateful stereo effects. Parameter order follows effect_specs.json. */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define PI 3.14159265358979323846

typedef struct {
    int kind, rate, capacity, clock, hold;
    double p[12], coefficient[5], z[2][2][2], aux[16];
    double phase, damping[4][2], high_x[2], high_y[2], low_y[2];
    double detector_x[2], detector_y[2], reduction, gain;
    float *rings[7];
} Effect;

static double clamp(double x, double low, double high) {
    return fmax(low, fmin(high, x));
}

static void biquad(Effect *e) {
    int type = (int)e->p[0];
    double w = 2 * PI * fmin(e->p[1], e->rate * .45) / e->rate;
    double c = cos(w), s = sin(w), alpha = s / (2 * e->p[2]);
    double a = pow(10, e->p[4] / ((int)e->p[3] == 1 ? 80 : 40));
    double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    if (type == 0) {
        b0 = b2 = (1-c)/2; b1 = 1-c; a0 = 1+alpha; a1 = -2*c; a2 = 1-alpha;
    } else if (type == 1) {
        b0 = b2 = (1+c)/2; b1 = -(1+c); a0 = 1+alpha; a1 = -2*c; a2 = 1-alpha;
    } else if (type == 2) {
        b0 = alpha; b2 = -alpha; a0 = 1+alpha; a1 = -2*c; a2 = 1-alpha;
    } else if (type == 3) {
        b0 = b2 = 1; b1 = -2*c; a0 = 1+alpha; a1 = -2*c; a2 = 1-alpha;
    } else if (type == 4) {
        b0 = 1+alpha*a; b1 = -2*c; b2 = 1-alpha*a;
        a0 = 1+alpha/a; a1 = -2*c; a2 = 1-alpha/a;
    } else {
        double beta = 2 * sqrt(a) * alpha;
        if (type == 5) {
            b0 = a*((a+1)-(a-1)*c+beta); b1 = 2*a*((a-1)-(a+1)*c); b2 = a*((a+1)-(a-1)*c-beta);
            a0 = (a+1)+(a-1)*c+beta; a1 = -2*((a-1)+(a+1)*c); a2 = (a+1)+(a-1)*c-beta;
        } else {
            b0 = a*((a+1)+(a-1)*c+beta); b1 = -2*a*((a-1)+(a+1)*c); b2 = a*((a+1)+(a-1)*c-beta);
            a0 = (a+1)-(a-1)*c+beta; a1 = 2*((a-1)-(a+1)*c); a2 = (a+1)-(a-1)*c-beta;
        }
    }
    e->coefficient[0] = b0/a0; e->coefficient[1] = b1/a0; e->coefficient[2] = b2/a0;
    e->coefficient[3] = a1/a0; e->coefficient[4] = a2/a0;
}

void sontrama_effect_configure(Effect *e, const double *p, int count) {
    memcpy(e->p, p, (size_t)count * sizeof(double));
    if (e->kind == 0) e->aux[0] = pow(10, p[0]/20);
    if (e->kind == 1) biquad(e);
    if (e->kind == 3) {
        const double times[4] = {.0297, .0371, .0411, .0437};
        for (int i = 0; i < 4; i++) {
            e->aux[i] = floor(e->rate * times[i] * (.6 + 1.6*p[2]));
            e->aux[4+i] = pow(10, -3 * e->aux[i] / (e->rate * p[0]));
        }
        e->aux[8] = 1-exp(-2*PI*fmin(p[3], e->rate*.45)/e->rate);
        e->aux[9] = exp(-2*PI*fmin(p[6], e->rate*.45)/e->rate);
        e->aux[10] = exp(-2*PI*fmin(p[7], e->rate*.45)/e->rate);
        e->aux[11] = p[4]*.7;
        e->aux[12] = floor(p[1]*.001*e->rate);
        e->aux[13] = floor(.005*e->rate); e->aux[14] = floor(.0017*e->rate);
    }
    if (e->kind == 4) {
        e->aux[0] = exp(-1/(p[2]*.001*e->rate));
        e->aux[1] = exp(-1/(p[3]*.001*e->rate));
        e->aux[2] = exp(-2*PI*p[6]/e->rate);
    }
    if (e->kind == 5) {
        e->aux[0] = pow(10, p[0]/20); e->aux[1] = pow(10, p[1]/20);
        e->aux[2] = exp(-1/(p[2]*.001*e->rate));
        e->aux[3] = floor(p[3]*.001*e->rate);
    }
}

void sontrama_effect_free(Effect *e) {
    if (!e) return;
    for (int i = 0; i < 7; i++) free(e->rings[i]);
    free(e);
}

Effect *sontrama_effect_create(int kind, int rate, const double *p, int count) {
    if (kind < 0 || kind > 5 || rate < 1000 || count > 12) return NULL;
    Effect *e = calloc(1, sizeof(Effect));
    if (!e) return NULL;
    e->kind = kind; e->rate = rate; e->capacity = (int)ceil(rate*.25)+4; e->gain = 1;
    int rings = kind == 3 ? 7 : (kind == 2 || kind == 5 ? 1 : 0);
    for (int i = 0; i < rings; i++) {
        e->rings[i] = calloc((size_t)e->capacity*2, sizeof(float));
        if (!e->rings[i]) { sontrama_effect_free(e); return NULL; }
    }
    sontrama_effect_configure(e, p, count);
    return e;
}

static double read_delay(Effect *e, int ring, double delay, int channel) {
    double at = e->clock-delay;
    if (at < 0) at += e->capacity;
    int first = (int)floor(at);
    double fraction = at-first;
    return e->rings[ring][first*2+channel]*(1-fraction)
        + e->rings[ring][((first+1)%e->capacity)*2+channel]*fraction;
}

static void width(double *left, double *right, double value) {
    double mid = (*left+*right)*.5, side = (*left-*right)*.5*value;
    *left = mid+side; *right = mid-side;
}

void sontrama_effect_process(Effect *e, const float *input, float *output, int frames) {
    const double *p = e->p;
    for (int frame = 0; frame < frames; frame++) {
        double x[2] = {input[frame*2], input[frame*2+1]}, y[2] = {x[0], x[1]};
        if (e->kind == 0) {
            width(&y[0], &y[1], p[1]); y[0] *= e->aux[0]; y[1] *= e->aux[0];
        } else if (e->kind == 1) {
            for (int stage = 0; stage < ((int)p[3] == 1 ? 2 : 1); stage++) {
                for (int ch = 0; ch < 2; ch++) {
                    double *z = e->z[stage][ch], *b = e->coefficient;
                    double result = y[ch]*b[0]+z[0];
                    z[0] = y[ch]*b[1]-result*b[3]+z[1]; z[1] = y[ch]*b[2]-result*b[4];
                    y[ch] = result;
                }
            }
            for (int ch = 0; ch < 2; ch++) y[ch] = x[ch]*(1-p[5])+y[ch]*p[5];
        } else if (e->kind == 2) {
            for (int ch = 0; ch < 2; ch++) {
                double delay = fmax(1, (p[2]+p[1]*sin(e->phase+ch*p[3]*PI/180))*.001*e->rate);
                double delayed = read_delay(e, 0, delay, ch);
                e->rings[0][e->clock*2+ch] = (float)(x[ch]+delayed*p[4]);
                y[ch] = x[ch]*(1-p[5])+delayed*p[5];
            }
            e->phase += 2*PI*p[0]/e->rate;
            if (e->phase >= 2*PI) e->phase -= 2*PI;
        } else if (e->kind == 3) {
            double predelay[2], wet[2] = {0, 0};
            for (int ch = 0; ch < 2; ch++) {
                predelay[ch] = e->aux[12] > 0 ? read_delay(e, 0, e->aux[12], ch) : x[ch];
                e->rings[0][e->clock*2+ch] = (float)x[ch];
            }
            for (int line = 0; line < 4; line++) {
                double delayed[2];
                for (int ch = 0; ch < 2; ch++) {
                    delayed[ch] = read_delay(e, line+1, e->aux[line], ch);
                    e->damping[line][ch] += e->aux[8]*(delayed[ch]-e->damping[line][ch]);
                    wet[ch] += delayed[ch]*.25;
                }
                for (int ch = 0; ch < 2; ch++)
                    e->rings[line+1][e->clock*2+ch] = (float)(predelay[ch]+e->damping[line][1-ch]*e->aux[line+4]);
            }
            for (int stage = 0; stage < 2; stage++) {
                for (int ch = 0; ch < 2; ch++) {
                    double delayed = read_delay(e, stage+5, e->aux[13+stage], ch);
                    double result = delayed-e->aux[11]*wet[ch];
                    e->rings[stage+5][e->clock*2+ch] = (float)(wet[ch]+e->aux[11]*result);
                    wet[ch] = result;
                }
            }
            width(&wet[0], &wet[1], p[5]);
            for (int ch = 0; ch < 2; ch++) {
                double high = e->aux[9]*(e->high_y[ch]+wet[ch]-e->high_x[ch]);
                e->high_x[ch] = wet[ch]; e->high_y[ch] = high;
                e->low_y[ch] = (1-e->aux[10])*high+e->aux[10]*e->low_y[ch];
                y[ch] = x[ch]*(1-p[8])+e->low_y[ch]*p[8];
            }
        } else if (e->kind == 4) {
            double peak = 1e-12;
            for (int ch = 0; ch < 2; ch++) {
                double high = e->aux[2]*(e->detector_y[ch]+x[ch]-e->detector_x[ch]);
                e->detector_x[ch] = x[ch]; e->detector_y[ch] = high;
                peak = fmax(peak, fabs(high));
            }
            double over = 20*log10(peak)-p[0], reduction = 0, knee = p[4];
            if (knee > 0 && fabs(over) <= knee*.5)
                reduction = (1-1/p[1])*pow(over+knee*.5, 2)/(2*knee);
            else if (over > knee*.5) reduction = over*(1-1/p[1]);
            double target = -reduction, coefficient = e->aux[target < e->reduction ? 0 : 1];
            e->reduction = coefficient*e->reduction+(1-coefficient)*target;
            double gain = pow(10, (e->reduction+p[5])/20);
            for (int ch = 0; ch < 2; ch++) y[ch] = x[ch]*(1-p[7])+x[ch]*gain*p[7];
        } else if (e->kind == 5) {
            double driven[2] = {x[0]*e->aux[1], x[1]*e->aux[1]};
            double peak = fmax(fabs(driven[0]), fabs(driven[1]));
            double needed = fmin(1, e->aux[0]/fmax(peak, 1e-12));
            if (needed < e->gain) { e->gain = needed; e->hold = (int)e->aux[3]; }
            else if (e->hold > 0) e->hold--;
            else e->gain = 1-e->aux[2]+e->aux[2]*e->gain;
            double delayed[2];
            for (int ch = 0; ch < 2; ch++) {
                delayed[ch] = e->aux[3] > 0 ? read_delay(e, 0, e->aux[3], ch) : driven[ch];
                e->rings[0][e->clock*2+ch] = (float)driven[ch];
            }
            double safe = fmin(e->gain, e->aux[0]/fmax(1e-12, fmax(fabs(delayed[0]), fabs(delayed[1]))));
            for (int ch = 0; ch < 2; ch++) y[ch] = clamp(delayed[ch]*safe, -e->aux[0], e->aux[0]);
        }
        output[frame*2] = (float)y[0]; output[frame*2+1] = (float)y[1];
        e->clock = (e->clock+1)%e->capacity;
    }
}
