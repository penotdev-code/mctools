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
      <a class="brand" href="/"><span class="brand__logo">🧰</span><span class="app-name">Boîte à outils</span></a>
      <span class="topbar__spacer"></span>
      <span class="topbar__tool">${document.title.replace(/[<>&]/g, "")}</span>
      <a class="btn btn--ghost btn--small" href="/">← Tous les outils</a>
    </div>`;
  document.body.prepend(bar);
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
      bar.querySelector(".app-name").textContent = c.name;
      document.title = document.title + " · " + c.name;
    })
    .catch(() => {});
})();
