//! Actual requested-byte allocation instrumentation for single-threaded bench runs.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
pub struct Tracking;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static CALLS: AtomicUsize = AtomicUsize::new(0);
fn add(n: usize) {
    let now = LIVE.fetch_add(n, Relaxed) + n;
    PEAK.fetch_max(now, Relaxed);
    CALLS.fetch_add(1, Relaxed);
}
// SAFETY: each allocation/deallocation forwards the caller's original pointer and
// Layout to System. Counters neither allocate nor change alignment or ownership.
unsafe impl GlobalAlloc for Tracking {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            add(l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let result = unsafe { System.realloc(p, l, n) };
        if !result.is_null() {
            LIVE.fetch_sub(l.size(), Relaxed);
            add(n);
        }
        result
    }
}
pub fn reset() -> (usize, usize) {
    let live = LIVE.load(Relaxed);
    PEAK.store(live, Relaxed);
    (live, CALLS.load(Relaxed))
}
pub fn finish(start: (usize, usize)) -> (usize, usize) {
    (
        PEAK.load(Relaxed).saturating_sub(start.0),
        CALLS.load(Relaxed).saturating_sub(start.1),
    )
}
/// getrusage measures the current process; single-threaded benchmark trials do
/// not run competing work in this process. RSS units differ by operating system.
#[cfg(unix)]
pub fn usage() -> (f64, f64, u64) {
    let mut value = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage writes one rusage to the valid uninitialized out pointer;
    // assume_init is used only after a successful return.
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, value.as_mut_ptr()) };
    if result != 0 {
        return (0.0, 0.0, 0);
    }
    let v = unsafe { value.assume_init() };
    let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1000000.0;
    let rss = v.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        (seconds(v.ru_utime), seconds(v.ru_stime), rss)
    } else {
        (seconds(v.ru_utime), seconds(v.ru_stime), rss * 1024)
    }
}
