"""Compatibility entry point for preparing the shared DSP before service startup."""

from .native_core import load_core

load_kernel = load_core
