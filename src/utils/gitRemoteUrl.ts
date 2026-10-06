/** Distinguish SSH URLs and SCP-style Git remotes from URLs with other schemes. */
export function isSshRemoteUrl(value: string): boolean {
  const remote = value.trimStart();
  if (/^ssh:\/\//i.test(remote)) return true;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) return false;
  return /^(?:[^@:/\s]+@)?[^@:/\s]+:.+/.test(remote);
}
