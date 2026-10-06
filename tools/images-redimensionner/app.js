/* Redimensionner des photos — traitement 100 % navigateur (canvas) */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtSize = (b) => (b < 1024 * 1024 ? Math.round(b / 1024) + " Ko" : (b / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Mo");
  const EXT = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };

  let outputs = []; // { name, blob, url }

  $("#quality").addEventListener("input", (e) => ($("#qualityValue").textContent = e.target.value + " %"));

  async function convert(file) {
    const maxSize = Number($("#maxSize").value);
    const type = $("#format").value;
    const quality = Number($("#quality").value) / 100;
    // createImageBitmap applique l'orientation EXIF (photos de téléphone)
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = maxSize ? Math.min(1, maxSize / Math.max(bmp.width, bmp.height)) : 1;
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (type === "image/jpeg") {
      ctx.fillStyle = "#fff"; // fond blanc pour les PNG transparents
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Conversion impossible"))), type, quality)
    );
    const base = file.name.replace(/\.[^.]+$/, "");
    return { name: `${base}-${w}px.${EXT[type]}`, blob, url: URL.createObjectURL(blob), w, h, before: file.size };
  }

  async function handle(files) {
    const err = $("#error");
    err.hidden = true;
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) {
      err.textContent = "Aucune image dans la sélection.";
      err.hidden = false;
      return;
    }
    for (const f of images) {
      try {
        outputs.push(await convert(f));
      } catch (e) {
        err.textContent = `« ${f.name} » n'a pas pu être lue (format non pris en charge ?).`;
        err.hidden = false;
      }
      render();
    }
  }

  function render() {
    $("#globalActions").hidden = !outputs.length;
    const before = outputs.reduce((s, o) => s + o.before, 0);
    const after = outputs.reduce((s, o) => s + o.blob.size, 0);
    $("#summary").textContent = outputs.length
      ? `${outputs.length} photo(s) · ${fmtSize(before)} → ${fmtSize(after)}`
      : "";
    $("#results").innerHTML = outputs
      .map((o, i) => {
        const gain = Math.round((1 - o.blob.size / o.before) * 100);
        return `<div class="result">
          <img src="${o.url}" alt="" loading="lazy" />
          <span class="result__name" title="${esc(o.name)}">${esc(o.name)}</span>
          <span class="result__sizes">${o.w}×${o.h} · ${fmtSize(o.before)} → ${fmtSize(o.blob.size)}
            ${gain > 0 ? `<span class="gain">−${gain} %</span>` : ""}</span>
          <a class="btn btn--small" href="${o.url}" download="${esc(o.name)}" data-i="${i}">⬇️ Télécharger</a>
        </div>`;
      })
      .join("");
  }

  const drop = $("#drop");
  $("#files").addEventListener("change", (e) => {
    handle(e.target.files);
    e.target.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("is-over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    handle(e.dataTransfer.files);
  });

  $("#downloadAll").addEventListener("click", async () => {
    for (const o of outputs) {
      const a = document.createElement("a");
      a.href = o.url;
      a.download = o.name;
      a.click();
      await new Promise((r) => setTimeout(r, 300)); // évite le blocage des téléchargements multiples
    }
  });
  $("#clear").addEventListener("click", () => {
    outputs.forEach((o) => URL.revokeObjectURL(o.url));
    outputs = [];
    render();
  });
})();
