/*
 * Troca a assinatura tipográfica da NEX pelo logotipo oficial,
 * usando o arquivo assets/img/logo-nex.png.
 * Sem o arquivo, a assinatura tipográfica continua visível.
 */
(function () {
  var signatures = document.querySelectorAll("[data-nex-signature]");
  if (!signatures.length) return;

  var root = document.documentElement.getAttribute("data-root") || "";
  var src = root + "assets/img/logo-nex.png";
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
