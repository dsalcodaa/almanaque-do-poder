/*
 * Troca a assinatura tipográfica da NEX pelo logotipo oficial,
 * mas só se o arquivo brand/nex/logo.svg existir no repositório.
 * Sem o arquivo, a assinatura tipográfica continua visível.
 */
(function () {
  var signatures = document.querySelectorAll("[data-nex-signature]");
  if (!signatures.length) return;

  var root = document.documentElement.getAttribute("data-root") || "";
  var src = root + "brand/nex/logo.svg";
  var probe = new Image();

  probe.onload = function () {
    signatures.forEach(function (el) {
      var img = document.createElement("img");
      img.src = src;
      img.alt = "NEX — Hub de Análise Estratégica";
      img.className = "nex-signature__logo";
      el.appendChild(img);
      el.classList.add("has-logo");
    });
  };
  probe.src = src;
})();
