// tsx asks os.userInfo() for a cache-directory suffix on Windows. Some
// restricted runtimes do not expose passwd/user-info APIs, even though the
// application itself can run normally. Supplying a process-local numeric id
// keeps the test loader portable without changing production behavior.
if (process.platform === 'win32' && typeof process.geteuid !== 'function') {
  Object.defineProperty(process, 'geteuid', {
    configurable: true,
    value: () => 0
  });
}
