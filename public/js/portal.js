/* ==========================================================
   Portail : liste des outils, recherche, filtre par catégorie
   ========================================================== */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Recherche insensible aux accents et à la casse
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  let config = { name: "", categories: [] };
  let tools = [];
  let category = "all";

  function card(t) {
    const inner = `
      <span class="tool-card__icon" aria-hidden="true">${esc(t.icon)}</span>
      <span class="tool-card__name">${esc(t.name)}</span>
      <p class="tool-card__desc">${esc(t.description)}</p>`;
    return t.status === "soon"
      ? `<div class="tool-card tool-card--soon" aria-disabled="true"><span class="badge">Bientôt</span>${inner}</div>`
      : `<a class="tool-card" href="${esc(t.url)}">${inner}</a>`;
  }

  function render() {
    const q = norm($("#search").value.trim());
    const visible = tools.filter((t) =>
      (category === "all" || t.category === category) &&
      (!q || norm([t.name, t.description, ...(t.keywords || [])].join(" ")).includes(q))
    );
    const cats = config.categories.concat(
      // Catégories utilisées par un outil mais absentes de config.json
      [...new Set(tools.map((t) => t.category))]
        .filter((id) => !config.categories.some((c) => c.id === id))
        .map((id) => ({ id, name: id, icon: "🔧" }))
    );
    $("#toolList").innerHTML = cats
      .map((c) => {
        const list = visible.filter((t) => t.category === c.id);
        if (!list.length) return "";
        return `<section class="category"><h2><span aria-hidden="true">${esc(c.icon)}</span>${esc(c.name)}</h2>
          <div class="grid">${list.map(card).join("")}</div></section>`;
      })
      .join("");
    const empty = $("#emptyState");
    empty.hidden = visible.length > 0;
    empty.textContent = tools.length
      ? "Aucun outil ne correspond à ta recherche."
      : "Aucun outil pour l'instant : ils arrivent bientôt.";
  }

  function renderFilters() {
    const used = new Set(tools.map((t) => t.category));
    const cats = [{ id: "all", name: "Tous" }].concat(config.categories.filter((c) => used.has(c.id)));
    $("#categoryFilter").innerHTML = cats
      .map((c) => `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${c.id === category}">${c.icon ? esc(c.icon) + " " : ""}${esc(c.name)}</button>`)
      .join("");
    $("#categoryFilter").hidden = cats.length <= 2;
  }

  $("#categoryFilter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    category = b.dataset.cat;
    renderFilters();
    render();
  });
  $("#search").addEventListener("input", render);

  Promise.all([fetch("/api/config").then((r) => r.json()), fetch("/api/tools").then((r) => r.json())])
    .then(([c, t]) => {
      config = c;
      tools = t;
      document.title = c.name;
      document.querySelectorAll(".app-name").forEach((el) => (el.textContent = c.name));
      $("#tagline").textContent = c.tagline || "";
      renderFilters();
      render();
    })
    .catch(() => {
      const empty = $("#emptyState");
      empty.hidden = false;
      empty.textContent = "Impossible de charger les outils. Réessaie dans un instant.";
    });
})();
