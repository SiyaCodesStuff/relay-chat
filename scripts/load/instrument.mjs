// Preserve both pg callback queries and promise/transaction return values.
export function instrument(target, name, record, classify = () => name) {
  const original = target[name].bind(target);
  target[name] = (...args) => {
    const started = performance.now();
    const label = classify(args);
    if (name === "query" && typeof args.at(-1) === "function") {
      const callback = args.at(-1);
      args[args.length - 1] = (...reply) => {
        record(label, performance.now() - started);
        return callback(...reply);
      };
      return original(...args);
    }
    const result = original(...args);
    if (result && typeof result.then === "function")
      return result.finally(() => record(label, performance.now() - started));
    return result;
  };
}
