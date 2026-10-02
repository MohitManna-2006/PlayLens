"""Deterministic play descriptors computed from canonical tracking."""

from .structural import (
    DESCRIPTOR_VERSION,
    DESCRIPTORS,
    WINDOW_FRAMES,
    DescriptorSpec,
    structural_descriptors,
)

__all__ = [
    "DESCRIPTORS",
    "DESCRIPTOR_VERSION",
    "WINDOW_FRAMES",
    "DescriptorSpec",
    "structural_descriptors",
]
