// Blocking head script: apply the theme before the first paint, independently of React.
(function () {
  var preference;
  try {
    preference = localStorage.getItem("relay-theme");
  } catch {
    /* Storage can be disabled. */
  }
  var dark =
    preference === "dark" ||
    (preference !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
