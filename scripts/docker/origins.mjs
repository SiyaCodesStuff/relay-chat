export function publicOrigin(value = "http://localhost:8080") {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== value ||
      url.username ||
      url.password
    )
      throw new Error();
    if (!url.hostname.startsWith("[") && !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error();
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error();
    return url;
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin, or HTTP on loopback only.");
  }
}

// HTTP loopback deployments support both browser hostnames at the same port.
// HTTPS and other validated origins retain their exact, single-origin policy.
export function deploymentOrigins(value) {
  const url = publicOrigin(value);
  if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    const port = url.port ? `:${url.port}` : "";
    return [`http://localhost${port}`, `http://127.0.0.1${port}`];
  }
  return [url.origin];
}
