//! Proof that a hostile length prefix never becomes a capacity.
//!
//! "Validate before allocating" is the kind of property that is true when it is
//! written and quietly false after a refactor moves one line, because every
//! other test still passes: the oversize frame is still rejected, just after a
//! 4 GiB allocation attempt. So this measures the allocator directly rather
//! than the return value.
//!
//! It lives in its own integration-test binary, and holds exactly **one**
//! `#[test]`, for two reasons: a `#[global_allocator]` is per-binary, and the
//! counters below are process-global — a second test running concurrently on
//! another thread would have its allocations attributed to this one.
#![allow(
    unsafe_code,
    reason = "a GlobalAlloc impl is unsafe by definition; this is a test-only \
              instrument, and the code under test contains no unsafe of its own"
)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use fpai_ipc::framing::{FrameError, MAX_FRAME_BODY, read_frame, write_frame};

static ARMED: AtomicBool = AtomicBool::new(false);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

/// Records the largest single allocation made while armed.
struct Watching;

// SAFETY: every method forwards to `System`, unchanged, with the same arguments
// and the same contract. The only added behaviour is a relaxed atomic load and
// a relaxed atomic max, which allocate nothing and cannot unwind.
unsafe impl GlobalAlloc for Watching {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // `vec![0u8; n]` lands here, not in `alloc`. Forgetting this override is
        // how this test would silently stop measuring anything.
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

fn record(size: usize) {
    if ARMED.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: Watching = Watching;

/// Run `f` with the allocator watching, and report the largest allocation.
fn largest_allocation_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.store(0, Ordering::SeqCst);
    ARMED.store(true, Ordering::SeqCst);
    let out = f();
    ARMED.store(false, Ordering::SeqCst);
    (out, LARGEST.load(Ordering::SeqCst))
}

fn hostile_frame() -> Vec<u8> {
    let mut wire = u32::MAX.to_be_bytes().to_vec();
    wire.extend_from_slice(b"x");
    wire
}

#[test]
fn a_u32_max_length_prefix_allocates_nothing() {
    // Control first: a legal frame really does allocate its body through this
    // allocator, so a small reading below means "did not allocate" rather than
    // "was not measured".
    let body = vec![b'x'; 512 * 1024];
    let mut legal = Vec::new();
    write_frame(&mut legal, &body).unwrap();
    let (decoded, control) = largest_allocation_during(|| read_frame(&mut legal.as_slice()));
    assert_eq!(decoded.unwrap().len(), body.len());
    assert!(
        control >= body.len(),
        "the instrument is not measuring: a {}-byte body registered a largest \
         allocation of {control} bytes",
        body.len()
    );

    // The hostile case: 0xFFFFFFFF declared, one byte of body actually present.
    let wire = hostile_frame();
    let (result, largest) = largest_allocation_during(|| read_frame(&mut wire.as_slice()));

    let err = result.expect_err("a 4 GiB declared length must be rejected");
    assert!(
        matches!(err, FrameError::TooLarge { declared: u32::MAX }),
        "got {err:?}"
    );
    assert!(
        largest <= 4096,
        "reading a frame with a u32::MAX length prefix allocated {largest} bytes; \
         the length must be validated before the body buffer is created"
    );
    assert!(largest < MAX_FRAME_BODY);

    // The async reader shares `validate_declared` with the sync one, but it has
    // its own `vec![0u8; declared]`, so it needs its own measurement.
    #[cfg(feature = "tokio")]
    {
        use fpai_ipc::framing::read_frame_async;

        // Built before arming so the runtime's start-up allocations are not
        // attributed to the read. `new_current_thread` keeps the read on this
        // thread, where the counters are meaningful.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let wire = hostile_frame();
        let (result, largest) = largest_allocation_during(|| {
            runtime.block_on(async { read_frame_async(&mut wire.as_slice()).await })
        });

        let err = result.expect_err("a 4 GiB declared length must be rejected");
        assert!(
            matches!(err, FrameError::TooLarge { declared: u32::MAX }),
            "got {err:?}"
        );
        assert!(
            largest <= 4096,
            "the async reader allocated {largest} bytes for a u32::MAX length prefix"
        );
    }
}
