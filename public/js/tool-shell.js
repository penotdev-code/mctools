/* ==========================================================
   En-tête commun des pages d'outils : retour au portail + nom.
   À inclure dans chaque tools/<id>/index.html :
     <script src="/js/tool-shell.js"></script>
   ========================================================== */
(function () {
  const bar = document.createElement("header");
  bar.className = "topbar";
  bar.innerHTML = `
    <div class="container topbar__inner">
      <a class="brand" href="/"><img class="brand__logo" src="/img/logo.svg" alt="" /><span class="app-name">MC Tools</span></a>
      <span class="topbar__spacer"></span>
      <span class="topbar__tool"></span>
      <a class="btn btn--ghost btn--small" href="/">← Tous les outils</a>
    </div>`;
  bar.querySelector(".topbar__tool").textContent = document.title;
  document.body.prepend(bar);
  if (!document.querySelector('link[rel="icon"]')) {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/svg+xml";
    icon.href = "/img/logo.svg";
    document.head.append(icon);
  }
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
      bar.querySelector(".app-name").textContent = c.name;
      document.title = document.title + " · " + c.name;
    })
    .catch(() => {});
})();
