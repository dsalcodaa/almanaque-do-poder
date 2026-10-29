/*
 * Almanaque do Poder — renderização das páginas a partir de data/*.json.
 * Cada página declara <body data-page="..."> e este arquivo chama o
 * renderizador correspondente.
 */
(function () {
  "use strict";

  var CASAS = {
    governo: "Governo do Amazonas",
    prefeituras: "Prefeituras",
    senado: "Senado Federal",
    camara: "Câmara dos Deputados",
    aleam: "Assembleia Legislativa (ALEAM)",
    cmm: "Câmara Municipal de Manaus"
  };
  var ORDEM_CASAS = ["governo", "senado", "camara", "aleam", "cmm", "prefeituras"];
  var HOMENAGENS = ["Título honorífico", "Utilidade pública", "Honraria", "Denominação", "Data comemorativa"];

  var cache = {};
  function carregar(nome) {
    if (!cache[nome]) {
      cache[nome] = fetch("data/" + nome, { cache: "no-cache" }).then(function (r) {
        if (!r.ok) throw new Error(nome + ": " + r.status);
        return r.json();
      });
    }
    return cache[nome];
  }

  // ---------- utilidades ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function semAcento(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function dataBR(iso) {
    if (!iso) return "";
    var p = iso.slice(0, 10).split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }
  function mesAno(iso) {
    if (!iso) return "";
    var p = iso.slice(0, 7).split("-");
    return p[1] + "/" + p[0];
  }
  function reais(v) {
    if (v == null) return "—";
    if (v >= 1e9) return "R$ " + (v / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " bi";
    if (v >= 1e6) return "R$ " + (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    return "R$ " + Math.round(v).toLocaleString("pt-BR");
  }
  function num(n) {
    return n == null ? "—" : Number(n).toLocaleString("pt-BR");
  }
  function iniciais(nome) {
    return String(nome || "")
      .split(/\s+/)
      .filter(function (p) { return p.length > 2 || /^[A-ZÁÉÍÓÚ]/.test(p); })
      .slice(0, 2)
      .map(function (p) { return p[0]; })
      .join("")
      .toUpperCase();
  }
  function foto(p, classe) {
    var ini = '<span class="avatar__ini" aria-hidden="true">' + esc(iniciais(p.nome)) + "</span>";
    if (!p.foto) return '<span class="avatar ' + (classe || "") + '">' + ini + "</span>";
    return (
      '<span class="avatar ' + (classe || "") + '">' + ini +
      '<img src="' + esc(p.foto) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' +
      "</span>"
    );
  }
  var FONTE_PRESENCA = {
    camara: "Câmara dos Deputados, registros de presença em sessões deliberativas.",
    senado: "Senado Federal, votações nominais: conta a sessão em que votou ou registrou presença.",
    cmm: "Câmara Municipal de Manaus (SAPL), presença em sessões ordinárias e extraordinárias.",
    aleam: "Assembleia Legislativa (SAPL), presença em sessões ordinárias e extraordinárias."
  };
  var FONTE_VOTOS = { camara: "Câmara dos Deputados, arquivos de votações.", senado: "Senado Federal, votações nominais." };
  function parteDe(id) { return "pessoas/" + id.slice(4, 6) + ".json"; }
  function fotoPessoa(r) { return r[8] ? "data/fotos/" + r[0] + ".webp" : null; }
  // Filtro "separar por cargo" do perfil. Cada eleição tem uma só candidatura,
  // então o ano identifica o cargo nos blocos de campanha e de território.
  var filtroCargo = { atual: "", anos: {} };
  function aplicarCargo() {
    var c = filtroCargo.atual, anos = c ? filtroCargo.anos[c] || {} : null;
    [].forEach.call(document.querySelectorAll("[data-cargo]"), function (el) { el.classList.toggle("fora-cargo", !!c && el.getAttribute("data-cargo") !== c); });
    [].forEach.call(document.querySelectorAll("[data-ano-bloco]"), function (el) { el.classList.toggle("fora-cargo", !!anos && !anos[el.getAttribute("data-ano-bloco")]); });
    [].forEach.call(document.querySelectorAll("[data-filtro-cargo]"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-filtro-cargo") === c)); });
    var sel = $("#terr-ano");
    if (sel) {
      var vis = [];
      [].forEach.call(sel.options, function (o) { o.hidden = o.disabled = !!anos && !anos[o.value]; if (!o.hidden) vis.push(o.value); });
      if (vis.length && vis.indexOf(sel.value) < 0) { sel.value = vis[0]; sel.dispatchEvent(new Event("change")); }
      sel.closest("section").classList.toggle("fora-cargo", !vis.length);
    }
  }
  function historicoHTML(pe) {
    var cs = pe.candidaturas.slice().sort(function (a, b) { return b.ano - a.ano; });
    var pat = {}, porCargo = {}, ordem = [];
    cs.forEach(function (c) {
      if (c.patrimonio != null) pat[String(c.ano)] = c.patrimonio;
      if (!porCargo[c.cargo]) { porCargo[c.cargo] = []; ordem.push(c.cargo); }
      porCargo[c.cargo].push(c);
    });
    filtroCargo.anos = {};
    ordem.forEach(function (k) { filtroCargo.anos[k] = {}; porCargo[k].forEach(function (c) { filtroCargo.anos[k][c.ano] = true; }); });
    var h = '<section class="section"><p class="kicker">Histórico eleitoral</p><h2 class="h2">Todas as candidaturas no Amazonas</h2>';
    if (ordem.length > 1) {
      h += '<h3 class="eleitos__cargo">Resumo por cargo</h3><div class="tabela-wrap"><table class="tabela"><thead><tr><th>Cargo</th><th class="num">Candidaturas</th><th class="num">Eleito(a)</th><th class="num">Melhor votação</th><th>Anos</th></tr></thead><tbody>' +
        ordem.map(function (k) {
          var l = porCargo[k], melhor = Math.max.apply(null, l.map(function (c) { return c.votos || 0; }));
          return "<tr><td>" + esc(k) + '</td><td class="num">' + l.length + '</td><td class="num">' + l.filter(function (c) { return c.eleito; }).length +
            '</td><td class="num">' + (melhor ? num(melhor) : "—") + "</td><td>" + l.map(function (c) { return c.ano; }).reverse().join(", ") + "</td></tr>";
        }).join("") + "</tbody></table></div>" +
        '<p class="kicker no-print" style="margin-top: var(--space-3);">Separar por cargo</p><ul class="rk-abas no-print"><li><button type="button" data-filtro-cargo="" aria-pressed="true">Todos os cargos</button></li>' +
        ordem.map(function (k) { return '<li><button type="button" data-filtro-cargo="' + esc(k) + '" aria-pressed="false">' + esc(k) + " (" + porCargo[k].length + ")</button></li>"; }).join("") + "</ul>";
    }
    h += '<div class="tabela-wrap" style="margin-top: var(--space-2);"><table class="tabela"><thead><tr><th>Ano</th><th>Cargo</th><th>Onde</th><th>Partido</th><th class="num">Votos</th><th>Resultado</th><th class="num">Bens declarados</th></tr></thead><tbody>' +
      cs.map(function (c) {
        return '<tr data-cargo="' + esc(c.cargo) + '"><td>' + c.ano + "</td><td>" + esc(c.cargo) + (c.urna ? '<span class="ledger__sub">' + esc(c.urna) + "</span>" : "") + "</td><td>" +
          (c.ue !== "Amazonas" ? '<a href="municipio.html?m=' + encodeURIComponent(slugJS(c.ue)) + '">' + esc(c.ue) + "</a>" : "Amazonas") + "</td><td>" + esc(c.partido || "—") +
          '</td><td class="num">' + (c.votos != null ? num(c.votos) : "—") + "</td><td>" + (c.eleito ? '<span class="tag tag--accent">' + esc(c.situacao) + "</span>" : esc(c.situacao || "—")) +
          '</td><td class="num">' + (c.patrimonio != null ? reais(c.patrimonio) : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    if (Object.keys(pat).length > 1) h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Evolução do patrimônio declarado</h3>' + linha(pat, reais, "Patrimônio declarado ao TSE em cada eleição");
    return h + '<p class="muted">Fonte: TSE, candidaturas, bens e votação nominal (2000 em diante; bens a partir de 2006). "—" indica dado não publicado pelo TSE.</p></section>';
  }
  function doacoesHTML(d) {
    var anos = Object.keys(d || {}).sort().reverse();
    if (!anos.length) return '<section class="section"><p class="kicker">Financiamento de campanha</p><h2 class="h2">Quem pagou as campanhas</h2>' +
      '<p class="prose">Não há prestação de contas no TSE para as campanhas desta pessoa de 2018 em diante. Eleições anteriores a 2018 ainda não foram incluídas, e há candidatos que não declararam receitas.</p></section>';
    return '<section class="section"><p class="kicker">Financiamento de campanha</p><h2 class="h2">Quem pagou as campanhas e com o que gastaram</h2>' + anos.map(function (a) {
      var x = d[a];
      return '<div data-ano-bloco="' + a + '"><h3 class="eleitos__cargo" style="margin-top: var(--space-4);">' + a + (x.cargo ? " · " + esc(x.cargo) : "") + (x.ue && x.ue !== "Amazonas" ? " em " + esc(x.ue) : "") + (x.partido ? " · " + esc(x.partido) : "") + "</h3>" +
        (!x.total ? "" : '<ul class="pillars"><li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(x.total) + '</span><p class="pillar__text">arrecadados na campanha</p></li>' +
        '<li class="pillar"><span class="pillar__index pillar__index--accent">' + pct(x.publico, x.total) + '</span><p class="pillar__text">dinheiro público (fundo eleitoral e fundo partidário)</p></li>' +
        '<li class="pillar"><span class="pillar__index">' + pct(x.proprio, x.total) + '</span><p class="pillar__text">do próprio bolso do candidato</p></li></ul>' +
        barras(x.origens, reais, "barras--reais") +
        '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Maiores financiadores</th><th>Tipo</th><th class="num">Valor</th></tr></thead><tbody>' +
        x.doadores.map(function (r) { return "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + '</td><td class="num">' + reais(r[2]) + "</td></tr>"; }).join("") + "</tbody></table></div>") +
        (x.estimado ? '<p class="muted">' + reais(x.estimado) + " foram doações estimadas (serviços ou bens cedidos, sem dinheiro).</p>" : "") +
        (x.gastos ? '<h4 class="sub-graf">Com o que gastou: ' + reais(x.gasto_total) + " em despesas contratadas</h4>" + barras(x.gastos, reais, "barras--reais", 12) +
          '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Maiores fornecedores da campanha</th><th>Tipo de gasto</th><th class="num">Valor</th></tr></thead><tbody>' +
          x.fornecedores.map(function (r) { return "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + '</td><td class="num">' + reais(r[2]) + "</td></tr>"; }).join("") + "</tbody></table></div>" : "") + "</div>";
    }).join("") + '<p class="muted">Fonte: TSE, prestação de contas final dos candidatos (2018 em diante). Desde 2015, empresas não podem doar para campanhas.</p></section>';
  }
  function territorioHTML(t) {
    var anos = Object.keys(t || {}).sort().reverse();
    if (!anos.length) return "";
    var h = '<section class="section" id="territorio-sec"><p class="kicker">Geografia do voto</p><h2 class="h2">Onde teve votos</h2>' +
      '<form class="filtros" onsubmit="return false"><label><span>Eleição</span><select id="terr-ano">' + anos.map(function (a) { return '<option value="' + a + '">' + a + "</option>"; }).join("") + "</select></label></form><div id=\"terr-corpo\"></div>" +
      '<p class="muted">Fonte: TSE, votação por município e zona (desde 2000) e por seção eleitoral, ligada ao bairro do local de votação (desde 2018). Votos do 1º turno.</p></section>';
    return h;
  }
  var terrDados = null;
  function territorioRender(t) {
    var sel = $("#terr-ano"), corpo = $("#terr-corpo");
    if (!sel || !corpo) return;
    terrDados = t;
    function render() { corpo.innerHTML = terrBloco(t, sel.value); }
    sel.addEventListener("change", render);
    render();
    aplicarCargo();
  }
  // No PDF saem todos os cargos e todas as eleições do território.
  window.addEventListener("beforeprint", function () {
    filtroCargo.salvo = filtroCargo.atual; filtroCargo.atual = ""; aplicarCargo();
    var corpo = $("#terr-corpo");
    if (corpo && terrDados) corpo.innerHTML = Object.keys(terrDados).sort().reverse().map(function (a) { return '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Eleição de ' + a + "</h3>" + terrBloco(terrDados, a); }).join("");
  });
  window.addEventListener("afterprint", function () {
    filtroCargo.atual = filtroCargo.salvo || ""; aplicarCargo();
    var sel = $("#terr-ano"), corpo = $("#terr-corpo");
    if (corpo && sel && terrDados) corpo.innerHTML = terrBloco(terrDados, sel.value);
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-filtro-cargo]");
    if (!b) return;
    filtroCargo.atual = b.getAttribute("data-filtro-cargo");
    aplicarCargo();
  });
  function terrBloco(t, ano) {
      var e = t[ano], h = "";
      var umMun = e.municipios.length === 1;
      if (!umMun) {
        var m = {};
        e.municipios.forEach(function (r) { m[r[0]] = r[1]; });
        h += '<h3 class="sub-graf">Votos por município (' + num(e.total) + " no total)</h3>" + barras(m, num, "barras--reais", 15);
      }
      if (e.bairros) {
        var b = {};
        e.bairros.forEach(function (r) { b[(umMun ? "" : r[0] + " · ") + r[1]] = r[2]; });
        h += '<h3 class="sub-graf">Votos por bairro' + (umMun ? " em " + esc(e.municipios[0][0]) + " (" + num(e.total) + " no total)" : "") + "</h3>" + barras(b, num, "barras--reais", 15);
      } else if (+ano < 2018) {
        h += '<p class="muted">Votos por bairro só a partir de 2018.</p>';
      }
      if (umMun && !e.bairros) h += '<p class="prose">' + num(e.total) + " votos em " + esc(e.municipios[0][0]) + ".</p>";
      return h;
  }
  function carregarTerritorio(id) {
    return carregar("territorio/" + id.slice(4, 6) + ".json").then(function (x) { return x[id]; }).catch(function () { return null; });
  }
  function mostrarTerritorio(id) {
    carregarTerritorio(id).then(function (t) {
      var box = $("#territorio");
      if (!box) return;
      box.outerHTML = territorioHTML(t);
      if (t) territorioRender(t);
    });
  }
  function carregarDoacoes(id) {
    return carregar("doacoes/" + id.slice(4, 6) + ".json").then(function (x) { return x[id]; }).catch(function () { return null; });
  }
  function slugJS(s) { return semAcento(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function param(nome) {
    return new URLSearchParams(location.search).get(nome);
  }
  function $(sel) { return document.querySelector(sel); }
  function erro(alvo, e) {
    alvo.innerHTML = '<p class="aviso">Não foi possível carregar os dados agora. ' + esc(e.message) + "</p>";
  }
  function pct(a, b) { return b ? Math.round((a / b) * 100) + "%" : "—"; }
  function idade(nasc) {
    if (!nasc) return null;
    var p = nasc.split("/"), d = new Date(+p[2], +p[1] - 1, +p[0]);
    return Math.floor((Date.now() - d) / 31557600000);
  }
  function somaPresenca(pr) {
    var a = 0, b = 0;
    Object.keys(pr || {}).forEach(function (k) { a += pr[k].presente; b += pr[k].sessoes; });
    return { presente: a, sessoes: b };
  }
  function ultimoAno(obj) {
    var ks = Object.keys(obj || {}).sort();
    return ks.length ? ks[ks.length - 1] : null;
  }
  function totalCota(p) {
    if (!p.cota) return null;
    return Object.keys(p.cota).reduce(function (t, a) { return t + p.cota[a].total; }, 0);
  }
  function cnpjFmt(c) {
    return String(c || "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  }
  function barras(obj, fmt, classe, limite) {
    var ks = Object.keys(obj || {}).filter(function (k) { return obj[k] > 0; }).slice(0, limite || 12);
    if (!ks.length) return "";
    var mx = Math.max.apply(null, ks.map(function (k) { return obj[k]; })) || 1;
    return '<ul class="barras ' + (classe || "") + '">' + ks.map(function (k) {
      return '<li><span class="barras__rot">' + esc(k) + '</span><span class="barras__trilho"><span class="barras__barra" style="width:' + (obj[k] / mx) * 100 + '%"></span></span><span class="barras__v">' + fmt(obj[k]) + "</span></li>";
    }).join("") + "</ul>";
  }
  function reaisCurto(v) {
    if (v >= 1e6) return (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (v >= 1e3) return (v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: v >= 1e5 ? 0 : 1 }) + " mil";
    return Math.round(v).toLocaleString("pt-BR");
  }
  function colunas(obj, fmt) {
    var ks = Object.keys(obj || {}).sort();
    if (!ks.length) return "";
    var mx = Math.max.apply(null, ks.map(function (k) { return obj[k]; })) || 1;
    var MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    return '<div class="colunas" role="img" aria-label="Valores por mês, em reais">' + ks.map(function (k) {
      var rot = /^\d{4}-\d{2}$/.test(k) ? MES[+k.slice(5) - 1] + (k.slice(5) === "01" ? " " + k.slice(2, 4) : "") : k;
      return '<div class="colunas__c" title="' + esc(rot + ": " + fmt(obj[k])) + '"><span class="colunas__v">' + (fmt === reais ? "R$ " + reaisCurto(obj[k]) : fmt(obj[k])) + '</span><span class="colunas__b" style="height:' + Math.max((obj[k] / mx) * 100, 1) + '%"></span><span class="colunas__r">' + esc(rot) + "</span></div>";
    }).join("") + "</div>";
  }
  // Gráfico de linha (uma série): pontos de 8px com valor ao passar o mouse, rótulo direto no primeiro e no último.
  function linha(obj, fmt, rotulo) {
    var ks = Object.keys(obj || {}).sort();
    if (ks.length < 2) return "";
    var W = 640, H = 230, ml = 12, mr = 12, mt = 28, mb = 46;
    var vs = ks.map(function (k) { return obj[k]; }), mx = Math.max.apply(null, vs) || 1;
    var x = function (i) { return ml + (i * (W - ml - mr)) / (ks.length - 1); };
    var y = function (v) { return mt + (1 - v / mx) * (H - mt - mb); };
    var pts = ks.map(function (k, i) { return x(i).toFixed(1) + "," + y(obj[k]).toFixed(1); }).join(" ");
    var curto = function (v) { return fmt === reais ? "R$ " + reaisCurto(v) : fmt(v); };
    // rótulo abaixo do ponto quando o vizinho é mais alto, para não cruzar a linha
    var abaixo = function (i) {
      var viz = [ks[i - 1], ks[i + 1]].filter(Boolean).map(function (k) { return obj[k]; });
      return Math.max.apply(null, viz) > obj[ks[i]];
    };
    var g = '<svg class="linha-graf" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(rotulo || "Evolução") + '">' +
      '<polyline class="linha-graf__l" points="' + pts + '"></polyline>' +
      ks.map(function (k, i) {
        var ponta = i === 0 || i === ks.length - 1;
        return '<g class="linha-graf__p"><circle class="linha-graf__alvo" cx="' + x(i) + '" cy="' + y(obj[k]) + '" r="14"></circle>' +
          '<circle class="linha-graf__m" cx="' + x(i) + '" cy="' + y(obj[k]) + '" r="4"></circle>' +
          '<text class="linha-graf__v' + (ponta ? " linha-graf__v--fixo" : "") + '" x="' + x(i) + '" y="' + (abaixo(i) ? y(obj[k]) + 18 : y(obj[k]) - 10) + '" text-anchor="' + (i === 0 ? "start" : i === ks.length - 1 ? "end" : "middle") + '">' + esc(curto(obj[k])) + "</text>" +
          "<title>" + esc(k + ": " + fmt(obj[k])) + "</title></g>" +
          '<text class="linha-graf__x" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 ? "start" : i === ks.length - 1 ? "end" : "middle") + '">' + esc(k) + "</text>";
      }).join("") + "</svg>";
    return '<figure class="linha-fig">' + g + "</figure>";
  }
  function pctHomenagem(p) {
    var m = p.metricas;
    if (!m || !m.normas) return null;
    return m.homenagens / m.normas;
  }

  // ---------- rodapé: data de atualização ----------
  function atualizacao() {
    var alvo = document.querySelector("[data-atualizado]");
    if (!alvo) return;
    carregar("meta.json").then(function (meta) {
      alvo.textContent = "Dados atualizados em " + dataBR(meta.gerado_em) + ".";
    }).catch(function () {});
  }

  // ---------- início ----------
  function paginaInicio() {
    var alvo = $("#painel");
    if (!alvo) return;
    Promise.all([carregar("politicos.json"), carregar("normas.json"), carregar("eleitos-2026.json").catch(function () { return []; })])
      .then(function (r) {
        var pol = r[0], normas = r[1], eleitos = r[2];
        var porCasa = {};
        pol.forEach(function (p) { porCasa[p.casa] = (porCasa[p.casa] || 0) + 1; });
        var hom = normas.filter(function (n) { return n.autor && HOMENAGENS.indexOf(n.categoria) >= 0; }).length;
        var comAutor = normas.filter(function (n) { return n.autor; }).length;

        var html = '<ul class="pillars">' +
          '<li class="pillar"><span class="pillar__index">' + num(pol.length) + '</span><p class="pillar__text">políticos em exercício no Amazonas, do Senado às prefeituras</p></li>' +
          '<li class="pillar"><span class="pillar__index">' + num(comAutor) + '</span><p class="pillar__text">normas de autoria parlamentar na legislatura atual</p></li>' +
          '<li class="pillar"><span class="pillar__index pillar__index--accent">' + (comAutor ? Math.round((hom / comAutor) * 100) : 0) + '%</span><p class="pillar__text">dessas normas são homenagem, título, data comemorativa ou utilidade pública</p></li>' +
          "</ul>";

        html += '<ul class="casas">';
        ORDEM_CASAS.forEach(function (c) {
          if (!porCasa[c]) return;
          html += '<li><a href="politicos.html?casa=' + c + '"><span class="casas__n">' + porCasa[c] + '</span><span class="casas__nome">' + esc(CASAS[c]) + "</span></a></li>";
        });
        html += "</ul>";
        alvo.innerHTML = html;

        var el = $("#eleitos");
        if (el && eleitos.length) {
          var grupos = {};
          eleitos.forEach(function (e) { (grupos[e.cargo] = grupos[e.cargo] || []).push(e); });
          var h = "";
          Object.keys(grupos).forEach(function (cargo) {
            h += '<div class="eleitos__grupo' + (grupos[cargo].length > 10 ? " eleitos__grupo--largo" : "") + '"><h3 class="eleitos__cargo">' + esc(cargo) + ' <span class="muted">(' + grupos[cargo].length + ")</span></h3><ul class=\"eleitos__lista\">";
            grupos[cargo].forEach(function (e) {
              h += "<li>" + esc(e.nome) + ' <span class="muted">' + esc(e.partido) + "</span></li>";
            });
            h += "</ul></div>";
          });
          el.innerHTML = h;
        }
      })
      .catch(function (e) { erro(alvo, e); });
  }

  // ---------- lista de políticos ----------
  function paginaTodos() {
    var lista = $("#lista-todos"), total = $("#total-todos"), fCargo = $("#t-cargo"), fMun = $("#t-mun"), fAno = $("#t-ano"), fSit = $("#t-sit"), fBusca = $("#t-busca");
    if (lista.getAttribute("data-ok")) return;
    lista.setAttribute("data-ok", "1");
    lista.innerHTML = '<li class="muted">Carregando o histórico (cerca de 40 mil nomes)…</li>';
    carregar("pessoas/indice.json").then(function (idx) {
      var unicos = function (i) { return Array.from(new Set(idx.map(function (r) { return r[i]; }))).sort(function (a, b) { return String(a).localeCompare(String(b), "pt"); }); };
      unicos(3).forEach(function (c) { fCargo.insertAdjacentHTML("beforeend", '<option value="' + esc(c) + '">' + esc(c) + "</option>"); });
      unicos(5).forEach(function (c) { fMun.insertAdjacentHTML("beforeend", '<option value="' + esc(c) + '">' + esc(c) + "</option>"); });
      unicos(4).reverse().forEach(function (c) { fAno.insertAdjacentHTML("beforeend", '<option value="' + c + '">' + c + "</option>"); });
      var limite = 60;
      function render() {
        var cg = fCargo.value, mu = fMun.value, an = fAno.value, si = fSit.value, q = semAcento(fBusca.value.trim());
        var f = idx.filter(function (r) {
          return (!cg || r[3] === cg) && (!mu || r[5] === mu) && (!an || String(r[4]) === an) &&
            (!si || (si === "eleito" ? r[7] > 0 : r[7] === 0)) && (!q || semAcento(r[1] + " " + r[2]).indexOf(q) >= 0);
        });
        total.textContent = num(f.length) + (f.length === 1 ? " pessoa" : " pessoas") + " · última candidatura de cada uma";
        lista.innerHTML = f.slice(0, limite).map(function (r) {
          return '<li><a class="card" href="politico.html?id=' + encodeURIComponent(r[0]) + '">' + foto({ nome: r[1], foto: fotoPessoa(r) }) +
            '<span class="card__corpo"><span class="card__nome">' + esc(r[1]) + "</span>" +
            '<span class="card__meta">' + esc(r[3]) + " · " + r[4] + (r[5] !== "Amazonas" ? " · " + esc(r[5]) : "") + "</span>" +
            '<span class="card__partido">' + esc(r[6] || "") + (r[7] ? " · eleito(a) " + r[7] + (r[7] === 1 ? " vez" : " vezes") : " · não eleito(a)") + "</span></span></a></li>";
        }).join("") || '<li class="muted">Ninguém encontrado com esses filtros.</li>';
        var b = $("#mais-todos");
        b.hidden = f.length <= limite;
      }
      $("#mais-todos").addEventListener("click", function () { limite += 120; render(); });
      [fCargo, fMun, fAno, fSit].forEach(function (el) { el.addEventListener("change", function () { limite = 60; render(); }); });
      fBusca.addEventListener("input", function () { limite = 60; render(); });
      if (param("q")) fBusca.value = param("q");
      render();
    }).catch(function (e) { erro(lista, e); });
  }

  function paginaPoliticos() {
    var abas = $("#abas-politicos");
    function trocar(aba) {
      [].forEach.call(abas.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-aba") === aba)); });
      $("#painel-atuais").hidden = aba !== "atuais";
      $("#painel-todos").hidden = aba !== "todos";
      if (aba === "todos") paginaTodos();
      history.replaceState(null, "", "politicos.html" + (aba === "todos" ? "?aba=todos" : ""));
    }
    abas.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) trocar(b.getAttribute("data-aba")); });
    trocar(param("aba") === "todos" ? "todos" : "atuais");
    var lista = $("#lista"), fCasa = $("#f-casa"), fPartido = $("#f-partido"), fBusca = $("#f-busca"), total = $("#total");
    carregar("politicos.json").then(function (pol) {
      ORDEM_CASAS.forEach(function (c) {
        if (pol.some(function (p) { return p.casa === c; })) fCasa.insertAdjacentHTML("beforeend", '<option value="' + c + '">' + esc(CASAS[c]) + "</option>");
      });
      var partidos = Array.from(new Set(pol.map(function (p) { return p.partido; }).filter(Boolean))).sort();
      partidos.forEach(function (s) { fPartido.insertAdjacentHTML("beforeend", '<option value="' + esc(s) + '">' + esc(s) + "</option>"); });
      if (param("casa")) fCasa.value = param("casa");
      if (param("partido")) fPartido.value = param("partido");

      function render() {
        var casa = fCasa.value, partido = fPartido.value, q = semAcento(fBusca.value.trim());
        var filtrados = pol.filter(function (p) {
          return (!casa || p.casa === casa) && (!partido || p.partido === partido) &&
            (!q || semAcento(p.nome + " " + p.nome_completo + " " + (p.municipio || "")).indexOf(q) >= 0);
        }).sort(function (a, b) {
          return ORDEM_CASAS.indexOf(a.casa) - ORDEM_CASAS.indexOf(b.casa) || semAcento(a.municipio || "").localeCompare(semAcento(b.municipio || "")) || semAcento(a.nome).localeCompare(semAcento(b.nome));
        });
        total.textContent = filtrados.length + (filtrados.length === 1 ? " político" : " políticos");
        lista.innerHTML = filtrados.map(function (p) {
          return '<li><a class="card" href="politico.html?id=' + encodeURIComponent(p.id) + '">' + foto(p) +
            '<span class="card__corpo"><span class="card__nome">' + esc(p.nome) + "</span>" +
            '<span class="card__meta">' + esc(p.cargo) + (p.municipio && p.casa === "prefeituras" ? " · " + esc(p.municipio) : "") + "</span>" +
            '<span class="card__partido">' + esc(p.partido || "Sem partido informado") + "</span></span></a></li>";
        }).join("") || '<li class="muted">Nenhum político encontrado.</li>';
      }
      [fCasa, fPartido].forEach(function (el) { el.addEventListener("change", render); });
      fBusca.addEventListener("input", render);
      render();
    }).catch(function (e) { erro(lista, e); });
  }

  // ---------- card para redes sociais (PNG 1080 x 1350) ----------
  function carregarImg(srcs) {
    return new Promise(function (ok) {
      var i = 0;
      (function prox() {
        if (i >= srcs.length) return ok(null);
        var im = new Image();
        im.crossOrigin = "anonymous"; // foto de outro site sem CORS falha aqui, em vez de bloquear o PNG
        im.onload = function () { ok(im); };
        im.onerror = function () { i++; prox(); };
        im.src = srcs[i];
      })();
    });
  }
  function quebrar(ctx, texto, larg, max) {
    var linhas = [], atual = "";
    String(texto || "").split(/\s+/).forEach(function (p) {
      var t = atual ? atual + " " + p : p;
      if (ctx.measureText(t).width > larg && atual) { linhas.push(atual); atual = p; } else atual = t;
    });
    if (atual) linhas.push(atual);
    if (linhas.length > max) { linhas = linhas.slice(0, max); linhas[max - 1] += "…"; }
    return linhas;
  }
  function gerarCard(d) {
    var W = 1080, H = 1350, M = 72, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var x = cv.getContext("2d"), SERIF = '"Source Serif 4", Georgia, serif', SANS = "Inter, system-ui, sans-serif";
    var INK = "#1a1a1a", MUTED = "#6b6660", ACC = "#b3261e";
    var fontes = document.fonts ? Promise.all(['700 64px "Source Serif 4"', "600 28px Inter", "400 28px Inter"].map(function (f) { return document.fonts.load(f); })).catch(function () {}) : null;
    return Promise.all([carregarImg(d.fotos), carregarImg(["assets/img/logo-icone.png"]), fontes]).then(function (r) {
      var im = r[0], logo = r[1];
      x.fillStyle = "#f1ece4"; x.fillRect(0, 0, W, H);
      x.fillStyle = INK; x.fillRect(0, 0, W, 14);
      if (logo) x.drawImage(logo, M, 52, 60, 60);
      x.font = "700 36px " + SERIF; x.fillText("Almanaque do Poder", M + (logo ? 76 : 0), 95);
      x.fillRect(M, 140, W - 2 * M, 3);
      // Foto quadrada, recortada pelo topo para manter o rosto
      var fy = 184, fs = 300;
      if (im) {
        var sw = Math.min(im.width, im.height);
        x.drawImage(im, (im.width - sw) / 2, 0, sw, sw, M, fy, fs, fs);
      } else {
        x.fillStyle = "#d9d2c6"; x.fillRect(M, fy, fs, fs);
        x.fillStyle = MUTED; x.font = "700 110px " + SERIF; x.textAlign = "center";
        x.fillText(iniciais(d.nome), M + fs / 2, fy + fs / 2 + 38); x.textAlign = "left";
      }
      var tx = M + fs + 44, tl = W - M - tx, y = fy + 30;
      x.fillStyle = ACC; x.font = "600 26px " + SANS;
      quebrar(x, d.kicker.toUpperCase(), tl, 2).forEach(function (l) { x.fillText(l, tx, y); y += 34; });
      y += 46; x.fillStyle = INK;
      var tam = d.nome.length > 22 ? 52 : 64;
      x.font = "700 " + tam + "px " + SERIF;
      quebrar(x, d.nome, tl, 3).forEach(function (l) { x.fillText(l, tx, y); y += tam * 1.08; });
      y += 8; x.fillStyle = MUTED; x.font = "400 26px " + SANS;
      quebrar(x, d.linha, tl, 3).forEach(function (l) { x.fillText(l, tx, y); y += 34; });
      // Números principais: duas colunas, até seis itens
      var gy = Math.max(fy + fs, y) + 56, cw = (W - 2 * M - 48) / 2;
      d.numeros.slice(0, 6).forEach(function (n, i) {
        var cx = M + (i % 2) * (cw + 48), cy = gy + Math.floor(i / 2) * 190;
        x.fillStyle = i === 0 ? ACC : INK; x.fillRect(cx, cy, cw, 3);
        var f = 60;
        do { x.font = "700 " + f + "px " + SERIF; f -= 4; } while (x.measureText(n[0]).width > cw && f > 28);
        x.fillStyle = INK; x.fillText(n[0], cx, cy + 72);
        x.fillStyle = MUTED; x.font = "400 24px " + SANS;
        quebrar(x, n[1], cw, 2).forEach(function (l, j) { x.fillText(l, cx, cy + 116 + j * 30); });
      });
      x.fillStyle = INK; x.fillRect(M, H - 150, W - 2 * M, 2);
      x.fillStyle = MUTED; x.font = "400 22px " + SANS;
      x.fillText("Dados oficiais: TSE, Câmara, Senado, ALEAM, CMM e Portal da Transparência.", M, H - 108);
      x.fillStyle = INK; x.font = "600 22px " + SANS;
      x.fillText("Desenvolvido pela NEX — Hub de Análise Estratégica", M, H - 72);
      x.fillStyle = MUTED; x.font = "400 22px " + SANS;
      x.fillText((location.host + location.pathname.replace(/[^/]*$/, "")).replace(/\/$/, ""), M, H - 38);
      return cv;
    });
  }
  function mostrarCard(d, botao) {
    var txt = botao.textContent;
    botao.disabled = true; botao.textContent = "Gerando…";
    var fim = function () { botao.disabled = false; botao.textContent = txt; };
    gerarCard(d).then(function (cv) {
      cv.toBlob(function (blob) {
        fim();
        if (!blob) return;
        var url = URL.createObjectURL(blob), nome = "almanaque-" + slugJS(d.nome) + ".png";
        var arq = window.File ? new File([blob], nome, { type: "image/png" }) : null;
        var pode = arq && navigator.canShare && navigator.canShare({ files: [arq] });
        var dlg = document.createElement("dialog");
        dlg.className = "card-dialog";
        dlg.innerHTML = '<img src="' + url + '" alt="Card de ' + esc(d.nome) + ' para redes sociais"><p class="card-dialog__acoes">' +
          '<a class="button" href="' + url + '" download="' + esc(nome) + '">Baixar imagem</a>' +
          (pode ? '<button class="button button--ghost" type="button" data-acao="compartilhar">Compartilhar</button>' : "") +
          '<button class="button button--ghost" type="button" data-acao="fechar">Fechar</button></p>';
        document.body.appendChild(dlg);
        dlg.addEventListener("click", function (e) {
          var a = e.target.getAttribute("data-acao");
          if (a === "fechar" || e.target === dlg) dlg.close();
          if (a === "compartilhar") navigator.share({ files: [arq], title: d.nome + " · Almanaque do Poder" }).catch(function () {});
        });
        dlg.addEventListener("close", function () { URL.revokeObjectURL(url); dlg.remove(); });
        dlg.showModal();
      }, "image/png");
    }).catch(fim);
  }
  function acoesPerfil() {
    return '<p class="no-print acoes-perfil"><button class="button" type="button" id="btn-card">Gerar card para redes sociais</button>' +
      '<button class="button button--ghost" type="button" onclick="window.print()">Exportar PDF</button></p>';
  }
  function ligarCard(d) {
    var b = $("#btn-card");
    if (b) b.addEventListener("click", function () { mostrarCard(d, b); });
  }
  function crachaHTML(cr) {
    return '<section class="section cracha"><ul class="cracha__lista">' + cr.map(function (c) {
      return '<li><span class="cracha__n">' + esc(c[0]) + '</span><span class="cracha__t">' + esc(c[1]) + "</span></li>";
    }).join("") + "</ul></section>";
  }

  // ---------- perfil ----------
  function paginaPessoa(alvo, id, pol) {
    var atual = pol.find(function (x) { return x.pessoa === id; });
    if (atual) { location.replace("politico.html?id=" + encodeURIComponent(atual.id)); return; }
    carregar(parteDe(id)).then(function (parte) {
      var pe = parte[id];
      if (!pe) { alvo.innerHTML = '<p class="aviso">Pessoa não encontrada. <a href="politicos.html?aba=todos">Voltar para a lista</a>.</p>'; return; }
      var cs = pe.candidaturas.slice().sort(function (a, b) { return b.ano - a.ano; }), u = cs[0];
      var nome = u.urna || pe.nome, ganhas = cs.filter(function (c) { return c.eleito; });
      document.title = nome + " · Almanaque do Poder";
      var h = '<section class="hero hero--perfil"><div class="perfil__topo">' + foto({ nome: nome, foto: pe.foto }, "avatar--grande") + "<div>" +
        '<p class="kicker">' + (ganhas.length ? "Eleito(a) " + ganhas.length + (ganhas.length === 1 ? " vez" : " vezes") : "Candidato(a), sem mandato conquistado") + "</p>" +
        '<h1 class="display">' + esc(nome) + "</h1>" +
        '<p class="lede">' + esc([pe.nome !== nome ? pe.nome : "", "última candidatura: " + u.cargo + " em " + u.ano + (u.ue !== "Amazonas" ? " (" + u.ue + ")" : ""), u.partido].filter(Boolean).join(" · ")) + "</p></div></div></section>";
      var cr = [];
      if (idade(pe.nascimento)) cr.push([idade(pe.nascimento) + " anos", "nascimento em " + pe.nascimento]);
      cr.push([num(cs.length), cs.length === 1 ? "candidatura no Amazonas" : "candidaturas no Amazonas desde " + cs[cs.length - 1].ano]);
      if (ganhas.length) cr.push([num(ganhas.length), ganhas.length === 1 ? "eleição vencida" : "eleições vencidas"]);
      var maisVotos = cs.reduce(function (m, c) { return (c.votos || 0) > (m.votos || 0) ? c : m; }, {});
      if (maisVotos.votos) cr.push([num(maisVotos.votos), "votos, o melhor resultado (" + maisVotos.cargo.toLowerCase() + ", " + maisVotos.ano + ")"]);
      var ultPat = cs.find(function (c) { return c.patrimonio != null; });
      if (ultPat) cr.push([reais(ultPat.patrimonio), "patrimônio declarado em " + ultPat.ano]);
      if (pe.ocupacao || pe.instrucao) cr.push([pe.ocupacao || "—", pe.instrucao || ""]);
      h += acoesPerfil() + crachaHTML(cr);
      h += historicoHTML(pe);
      h += '<div id="territorio"></div><div id="doacoes"></div>';
      h += '<section class="section"><p class="kicker">Mandato</p><h2 class="h2">Votações, presença e gastos</h2><p class="prose">' +
        (ganhas.length
          ? "Não há registros de votações, presença ou gastos para este nome no site. Esses dados só existem a partir de 2023 e só para quem exerceu mandato na Câmara Municipal de Manaus, na Assembleia Legislativa, na Câmara dos Deputados ou no Senado. Câmaras dos outros municípios não publicam esses dados em formato aberto. Mandatos anteriores a 2023 ainda não foram incluídos."
          : "Sem mandato conquistado nas eleições registradas pelo TSE, por isso não há votações, presença ou gastos de gabinete.") +
        '</p><p><a href="gastos.html">Pesquisar o nome nos gastos de gabinete</a> · <a href="diario.html">Buscar no Diário Oficial</a></p></section>';
      alvo.innerHTML = h;
      ligarCard({ nome: nome, kicker: ganhas.length ? "Eleito(a) " + ganhas.length + (ganhas.length === 1 ? " vez" : " vezes") : "Candidato(a)",
        linha: [u.partido, "última candidatura: " + u.cargo + " em " + u.ano].filter(Boolean).join(" · "), fotos: pe.foto ? [pe.foto] : [], numeros: cr });
      carregarDoacoes(id).then(function (d) { var box = $("#doacoes"); if (box) box.outerHTML = doacoesHTML(d); aplicarCargo(); });
      mostrarTerritorio(id);
    }).catch(function (e) { erro(alvo, e); });
  }

  function paginaPolitico() {
    var alvo = $("#perfil"), id = param("id");
    if (id && id.indexOf("tse-") === 0) {
      carregar("politicos.json").then(function (pol) { paginaPessoa(alvo, id, pol); }).catch(function (e) { erro(alvo, e); });
      return;
    }
    Promise.all([carregar("politicos.json"), carregar("normas.json")]).then(function (r) {
      var p = r[0].find(function (x) { return x.id === id; });
      if (!p) { alvo.innerHTML = '<p class="aviso">Político não encontrado. <a href="politicos.html">Voltar para a lista</a>.</p>'; return; }
      document.title = p.nome + " · Almanaque do Poder";
      if (p.pessoa) {
        setTimeout(function () {
          carregar(parteDe(p.pessoa)).then(function (parte) {
            var box = $("#historico");
            if (box && parte[p.pessoa]) { box.outerHTML = historicoHTML(parte[p.pessoa]); aplicarCargo(); }
          }).catch(function () {});
          carregarDoacoes(p.pessoa).then(function (d) { var box = $("#doacoes"); if (box) box.outerHTML = doacoesHTML(d); aplicarCargo(); });
          mostrarTerritorio(p.pessoa);
        }, 0);
      }
      var m = p.metricas;
      var normas = r[1].filter(function (n) { return n.autor === p.id; });

      var h = '<section class="hero hero--perfil"><div class="perfil__topo">' + foto(p, "avatar--grande") + "<div>" +
        '<p class="kicker">' + esc(p.cargo) + (p.municipio && p.casa === "prefeituras" ? " · " + esc(p.municipio) : "") + "</p>" +
        '<h1 class="display">' + esc(p.nome) + "</h1>" +
        '<p class="lede">' + (p.partido ? '<a href="partidos.html?p=' + encodeURIComponent(p.partido) + '">' + esc(p.partido) + "</a> · " : "") + esc([CASAS[p.casa], p.periodo ? "dados desde " + dataBR(p.periodo) : ""].filter(Boolean).join(" · ")) + "</p>" +
        "</div></div>";
      if (p.nota) h += '<p class="nota">' + esc(p.nota) + "</p>";
      h += "</section>";

      // Crachá: os números principais do mandato, cada um com fonte oficial
      var cr = [], el = p.eleicao, pr = somaPresenca(p.presenca), tc = totalCota(p);
      if (el && el.votos) cr.push([num(el.votos), "votos na eleição de " + el.ano + " para " + el.cargo.toLowerCase() + " · " + el.situacao.toLowerCase().replace("por qp", "por quociente partidário")]);
      if (el && el.patrimonio != null) cr.push([reais(el.patrimonio), "patrimônio declarado ao TSE em " + el.ano]);
      if (el && idade(el.nascimento)) cr.push([idade(el.nascimento) + " anos", [el.instrucao, el.ocupacao].filter(Boolean).join(" · ")]);
      if (pr.sessoes) cr.push([pct(pr.presente, pr.sessoes), "presença em sessões (" + num(pr.presente) + " de " + num(pr.sessoes) + ")"]);
      if (pr.sessoes) cr.push([num(pr.sessoes - pr.presente), "faltas em sessões desde " + Object.keys(p.presenca).sort()[0]]);
      if (p.votacoes && p.votacoes.com_orientacao) cr.push([pct(p.votacoes.seguiu_partido, p.votacoes.com_orientacao), "das votações, votou com a maioria do próprio partido"]);
      if (tc != null) cr.push([reais(tc), "de cota parlamentar desde " + Object.keys(p.cota).sort()[0]]);
      if (p.emendas) cr.push([reais(p.emendas.pago), "em emendas pagas desde " + p.emendas.desde]);
      h += acoesPerfil();
      if (cr.length) h += crachaHTML(cr);

      if (m) {
        h += '<section class="section"><ul class="pillars">' +
          '<li class="pillar"><span class="pillar__index">' + num(m.proposicoes) + '</span><p class="pillar__text">proposições apresentadas (' + esc(m.autoria) + ")</p></li>";
        if (m.normas != null) {
          h += '<li class="pillar"><span class="pillar__index">' + num(m.normas) + '</span><p class="pillar__text">normas aprovadas como primeiro autor</p></li>' +
            '<li class="pillar"><span class="pillar__index pillar__index--accent">' + num(m.homenagens) + '</span><p class="pillar__text">são homenagem, título, data comemorativa, denominação ou utilidade pública</p></li>';
        } else {
          h += '<li class="pillar"><span class="pillar__index">—</span><p class="pillar__text">normas aprovadas: a API da Câmara não informa quais proposições viraram lei</p></li>';
        }
        h += "</ul></section>";

        var tipos = Object.keys(m.proposicoes_tipo || {});
        if (tipos.length) {
          var max = Math.max.apply(null, tipos.map(function (t) { return m.proposicoes_tipo[t]; }));
          h += '<section class="section"><p class="kicker">Proposições</p><h2 class="h2">Por tipo</h2><ul class="barras">';
          tipos.slice(0, 10).forEach(function (t) {
            var v = m.proposicoes_tipo[t];
            h += '<li><span class="barras__rot">' + esc(t) + '</span><span class="barras__trilho"><span class="barras__barra" style="width:' + (v / max) * 100 + '%"></span></span><span class="barras__v">' + num(v) + "</span></li>";
          });
          h += "</ul></section>";
        }

        var cats = Object.keys(m.normas_categoria || {});
        if (cats.length) {
          var maxc = Math.max.apply(null, cats.map(function (c) { return m.normas_categoria[c]; }));
          h += '<section class="section"><p class="kicker">Normas aprovadas</p><h2 class="h2">Por categoria</h2><ul class="barras">';
          cats.forEach(function (c) {
            var v = m.normas_categoria[c], destaque = HOMENAGENS.indexOf(c) >= 0;
            h += '<li><span class="barras__rot">' + esc(c) + '</span><span class="barras__trilho"><span class="barras__barra' + (destaque ? " barras__barra--accent" : "") + '" style="width:' + (v / maxc) * 100 + '%"></span></span><span class="barras__v">' + num(v) + "</span></li>";
          });
          h += "</ul></section>";
        }
      }

      if (p.presenca && pr.sessoes) {
        var anosP = Object.keys(p.presenca).sort().reverse();
        h += '<section class="section"><p class="kicker">Presença e faltas</p><h2 class="h2">Sessões no Plenário</h2>' +
          '<ul class="pillars"><li class="pillar"><span class="pillar__index">' + pct(pr.presente, pr.sessoes) + '</span><p class="pillar__text">de presença (' + num(pr.presente) + " de " + num(pr.sessoes) + " sessões)</p></li>" +
          '<li class="pillar"><span class="pillar__index pillar__index--accent">' + num(pr.sessoes - pr.presente) + '</span><p class="pillar__text">faltas no período</p></li></ul>' +
          '<ul class="ledger">' + anosP.map(function (a) {
            var x = p.presenca[a];
            return '<li><span class="ledger__key">' + esc(a) + "</span><span><strong>" + pct(x.presente, x.sessoes) + "</strong> · presente em " + num(x.presente) + " de " + num(x.sessoes) + " sessões · <strong>" + num(x.sessoes - x.presente) + (x.sessoes - x.presente === 1 ? " falta" : " faltas") + "</strong></span></li>";
          }).join("") + "</ul>" +
          (p.ausencias && Object.keys(p.ausencias).length ? '<p class="muted">Motivos registrados nas ausências: ' + Object.keys(p.ausencias).map(function (k) { return esc(k) + " (" + num(p.ausencias[k]) + ")"; }).join(", ") + ".</p>" : "") +
          '<p class="muted">Fonte: ' + esc(FONTE_PRESENCA[p.casa] || "registros oficiais de presença.") + " Licenças e faltas justificadas contam como ausência.</p></section>";
      }

      if (p.votacoes && p.votacoes.total) {
        var vt = p.votacoes;
        h += '<section class="section"><p class="kicker">Como votou</p><h2 class="h2">Votações nominais no Plenário</h2>' +
          '<ul class="pillars"><li class="pillar"><span class="pillar__index">' + num(vt.sim) + '</span><p class="pillar__text">votos Sim</p></li>' +
          '<li class="pillar"><span class="pillar__index">' + num(vt.nao) + '</span><p class="pillar__text">votos Não</p></li>' +
          (vt.com_orientacao ? '<li class="pillar"><span class="pillar__index pillar__index--accent">' + pct(vt.seguiu_partido, vt.com_orientacao) + '</span><p class="pillar__text">votou com a maioria do partido (' + num(vt.seguiu_partido) + " de " + num(vt.com_orientacao) + ")</p></li>" : "") + "</ul>" +
          '<ul class="ledger votos">' + vt.recentes.slice(0, 15).map(function (v) {
            var cls = v.voto === "Sim" ? "voto--sim" : v.voto === "Não" ? "voto--nao" : "";
            return '<li><span class="ledger__key">' + esc(dataBR(v.data)) + '</span><span><span class="voto ' + cls + '">' + esc(v.voto) + "</span> " + esc(v.descricao) +
              '<span class="ledger__sub">' + (v.proposicao ? esc(v.proposicao) + " · " : "") + (v.aprovada ? "aprovada" : "rejeitada") + (v.maioria_partido ? " · maioria do " + esc(v.partido) + " votou " + esc(v.maioria_partido) : "") + "</span></span></li>";
          }).join("") + '</ul><p class="muted">Últimas 15 votações. Fonte: ' + esc(FONTE_VOTOS[p.casa] || "registros oficiais.") + "</p></section>";
      }

      if (p.cota) {
        var anoC = ultimoAno(p.cota), c = p.cota[anoC], cat1 = Object.keys(c.por_categoria || {})[0];
        h += '<section class="section"><p class="kicker">Cota parlamentar</p><h2 class="h2">Dinheiro do gabinete em ' + esc(anoC) + "</h2>" +
          '<p class="muted">Verba mensal que reembolsa combustível, aluguel de carros, divulgação, consultoria e outras despesas do mandato. Cada gasto exige nota fiscal.</p>' +
          '<ul class="pillars" style="margin-top: var(--space-3);"><li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(c.total) + '</span><p class="pillar__text">reembolsado em ' + esc(anoC) + " (" + num(c.notas) + " notas)</p></li>" +
          (c.uso != null ? '<li class="pillar"><span class="pillar__index pillar__index--accent">' + Math.round(c.uso * 100) + '%</span><p class="pillar__text">da cota disponível no ano (' + reais(c.cota_disponivel) + ")</p></li>" : "") +
          (cat1 ? '<li class="pillar"><span class="pillar__index pillar__index--valor">' + pct(c.por_categoria[cat1], c.total) + '</span><p class="pillar__text">foi para ' + esc(cat1.toLowerCase()) + "</p></li>" : "") +
          "</ul>" +
          '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Mês a mês</h3>' + colunas(c.por_mes, reais) +
          '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Com o que gastou</h3>' + barras(c.por_categoria, reais, "barras--reais") +
          '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Quem mais recebeu</h3><ul class="ledger">' + c.fornecedores.map(function (f) {
            return '<li><span class="ledger__key">' + reais(f.valor) + "</span><span>" + esc(f.nome) + (f.cnpj ? '<span class="ledger__sub">CNPJ ' + esc(cnpjFmt(f.cnpj)) + "</span>" : "") + "</span></li>";
          }).join("") + "</ul>";
        var anosC = Object.keys(p.cota).sort().reverse();
        if (anosC.length > 1) {
          h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Ano a ano</h3><ul class="ledger">' + anosC.map(function (a) {
            var x = p.cota[a];
            return '<li><span class="ledger__key">' + esc(a) + "</span><span><strong>" + reais(x.total) + "</strong> · " + num(x.notas) + " notas" + (x.uso != null ? " · " + Math.round(x.uso * 100) + "% da cota" : "") + "</span></li>";
          }).join("") + "</ul>";
        }
        h += '<p><a href="gastos.html?politico=' + encodeURIComponent(p.id) + '">Ver cada nota fiscal</a></p></section>';
      }

      if (p.diario && p.diario.total) {
        h += '<section class="section"><p class="kicker">Diário Oficial</p><h2 class="h2">Citações recentes</h2>' +
          '<p class="muted">' + num(p.diario.total) + (p.diario.total === 1 ? " citação" : " citações") + " nos diários oficiais da ALEAM, da Câmara Municipal de Manaus e do Estado nos últimos 12 meses.</p>" +
          '<ul class="ledger diario">' + p.diario.recentes.map(function (m) { return itemDiario(m, false); }).join("") + "</ul>" +
          '<p><a href="diario.html?politico=' + encodeURIComponent(p.id) + '">Ver todas as citações</a></p></section>';
      }

      if (p.pessoa) h += '<div id="historico"></div><div id="territorio"></div><div id="doacoes"></div>';

      var em = p.emendas;
      if (em) {
        h += '<section class="section"><p class="kicker">Emendas parlamentares</p><h2 class="h2">Dinheiro indicado ao orçamento</h2>' +
          '<p class="muted">Desde ' + esc(em.desde) + ", segundo o Portal da Transparência.</p>" +
          '<ul class="pillars" style="margin-top: var(--space-3);">' +
          '<li class="pillar"><span class="pillar__index">' + num(em.quantidade) + '</span><p class="pillar__text">emendas com execução registrada</p></li>' +
          '<li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(em.empenhado) + '</span><p class="pillar__text">empenhado (reservado no orçamento)</p></li>' +
          '<li class="pillar"><span class="pillar__index pillar__index--accent pillar__index--valor">' + reais(em.pago) + '</span><p class="pillar__text">efetivamente pago, incluindo restos a pagar</p></li></ul>';
        [["Por área", em.por_funcao], ["Por destino", em.por_local], ["Pago por ano", em.por_ano]].forEach(function (g) {
          var ks = Object.keys(g[1] || {}).filter(function (k) { return g[1][k] > 0; });
          if (!ks.length) return;
          var mx = Math.max.apply(null, ks.map(function (k) { return g[1][k]; })) || 1;
          h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">' + esc(g[0]) + '</h3><ul class="barras barras--reais">';
          ks.forEach(function (k) {
            h += '<li><span class="barras__rot">' + esc(k === "MÚLTIPLO" ? "Vários destinos" : k) + '</span><span class="barras__trilho"><span class="barras__barra" style="width:' + (g[1][k] / mx) * 100 + '%"></span></span><span class="barras__v">' + reais(g[1][k]) + "</span></li>";
          });
          h += "</ul>";
        });
        h += '<p class="muted" style="margin-top: var(--space-2);"><a href="https://portaldatransparencia.gov.br/emendas/consulta?autor=' + encodeURIComponent(em.autor_portal) + '" target="_blank" rel="noopener">Ver no Portal da Transparência</a></p></section>';
      }

      if (normas.length) {
        h += '<section class="section"><p class="kicker">As leis</p><h2 class="h2">Normas aprovadas</h2><ul class="ledger">';
        normas.slice(0, 30).forEach(function (n) {
          h += '<li><span class="ledger__key">' + esc(mesAno(n.data)) + '</span><span><a href="' + esc(n.url) + '" target="_blank" rel="noopener">' + esc(n.tipo) + " nº " + esc(n.numero) + "</a> — " + esc(n.ementa) +
            ' <span class="tag' + (HOMENAGENS.indexOf(n.categoria) >= 0 ? " tag--accent" : "") + '">' + esc(n.categoria) + "</span></span></li>";
        });
        h += "</ul>";
        if (normas.length > 30) h += '<p><a href="leis.html?autor=' + encodeURIComponent(p.id) + '">Ver todas as ' + normas.length + " normas</a></p>";
        h += "</section>";
      }

      h += '<section class="section"><p class="kicker">Contato e fonte</p><ul class="ledger">';
      if (p.nome_completo) h += '<li><span class="ledger__key">Nome civil</span><span>' + esc(p.nome_completo) + "</span></li>";
      if (p.profissao) h += '<li><span class="ledger__key">Profissão</span><span>' + esc(p.profissao) + "</span></li>";
      if (p.email) h += '<li><span class="ledger__key">E-mail</span><span><a href="mailto:' + esc(p.email) + '">' + esc(p.email) + "</a></span></li>";
      if (p.fonte) h += '<li><span class="ledger__key">Fonte</span><span><a href="' + esc(p.fonte) + '" target="_blank" rel="noopener">' + esc(p.fonte) + "</a></span></li>";
      h += "</ul></section>";
      alvo.innerHTML = h;
      ligarCard({ nome: p.nome, kicker: p.cargo + (p.municipio && p.casa === "prefeituras" ? " · " + p.municipio : ""),
        linha: [p.partido, CASAS[p.casa]].filter(Boolean).join(" · "),
        fotos: [p.pessoa ? "data/fotos/" + p.pessoa + ".webp" : "", p.foto].filter(Boolean), numeros: cr });
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- leis e projetos ----------
  function nomeLei(tipo, numero, ano) {
    tipo = tipo || "Lei";
    if (!numero || numero === "s/n") return esc(tipo) + (ano ? " de " + ano : "");
    return esc(tipo) + " nº " + esc(numero) + (ano ? "/" + ano : "");
  }
  function linhaLei(r, lugar) {
    return '<li><span class="ledger__key">' + (r[2] || "—") + "</span><span>" +
      '<a href="' + esc(r[6]) + '" target="_blank" rel="noopener"><strong>' + nomeLei(r[0], r[1], r[2]) + "</strong></a>" +
      (lugar ? ' <span class="muted">· ' + esc(lugar) + "</span>" : "") +
      (r[4] ? '<span class="ledger__sub">' + esc(r[4].length > 280 ? r[4].slice(0, 280) + "…" : r[4]) + "</span>" : '<span class="ledger__sub muted">Ementa não identificada; veja o texto na fonte.</span>') +
      (r[5] ? ' <span class="tag' + (HOMENAGENS.indexOf(r[5]) >= 0 ? " tag--accent" : "") + '">' + esc(r[5]) + "</span>" : "") +
      ' <span class="muted" style="font-size:0.75rem">' + esc(r[7]) + "</span></span></li>";
  }
  function paginaAcervo() {
    var fLugar = $("#a-lugar"), fTipo = $("#a-tipo"), fCat = $("#a-cat"), fAno = $("#a-ano"), fBusca = $("#a-busca"), lista = $("#a-lista"), total = $("#a-total"), mais = $("#a-mais");
    if (lista.getAttribute("data-ok")) return;
    lista.setAttribute("data-ok", "1");
    var limite = 50, dados = [];
    carregar("leis/resumo.json").then(function (res) {
      var ks = Object.keys(res).filter(function (k) { return k !== "estado"; }).sort(function (a, b) { return res[a].nome.localeCompare(res[b].nome, "pt"); });
      fLugar.innerHTML = '<option value="estado">Estado do Amazonas (' + num(res.estado ? res.estado.total : 0) + " leis)</option>" +
        ks.map(function (k) { return '<option value="' + k + '">' + esc(res[k].nome) + " (" + num(res[k].total) + ")</option>"; }).join("");
      if (param("m") && res[param("m")]) fLugar.value = param("m");
      function render() {
        var t = fTipo.value, ct = fCat.value, a = fAno.value, q = semAcento(fBusca.value.trim());
        var f = dados.filter(function (r) {
          return (!t || r[0] === t) && (!ct || r[5] === ct) && (!a || String(r[2]) === a) && (!q || semAcento(r[1] + " " + r[4]).indexOf(q) >= 0);
        });
        total.textContent = num(f.length) + (f.length === 1 ? " lei" : " leis");
        lista.innerHTML = f.slice(0, limite).map(function (r) { return linhaLei(r); }).join("") || '<li class="muted">Nenhuma lei com esses filtros.</li>';
        mais.hidden = f.length <= limite;
      }
      function carregarLugar() {
        lista.innerHTML = '<li class="muted">Carregando…</li>';
        carregar("leis/" + fLugar.value + ".json").then(function (d) {
          dados = d;
          var opc = function (el, vals, rot) { el.innerHTML = '<option value="">' + rot + "</option>" + vals.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + "</option>"; }).join(""); };
          opc(fTipo, Array.from(new Set(d.map(function (r) { return r[0]; }))).filter(Boolean).sort(), "Todos");
          opc(fCat, Array.from(new Set(d.map(function (r) { return r[5]; }))).filter(Boolean).sort(), "Todas");
          opc(fAno, Array.from(new Set(d.map(function (r) { return r[2]; }))).filter(Boolean).sort().reverse(), "Todos");
          limite = 50;
          render();
        }).catch(function (e) { erro(lista, e); });
      }
      fLugar.addEventListener("change", carregarLugar);
      [fTipo, fCat, fAno].forEach(function (el) { el.addEventListener("change", function () { limite = 50; render(); }); });
      fBusca.addEventListener("input", function () { limite = 50; render(); });
      mais.addEventListener("click", function () { limite += 100; render(); });
      carregarLugar();
    }).catch(function (e) { erro(lista, e); });
  }

  function paginaLeis() {
    var abas = $("#abas-leis");
    if (abas) {
      var trocar = function (aba) {
        [].forEach.call(abas.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-aba") === aba)); });
        $("#painel-pol").hidden = aba !== "pol";
        $("#painel-acervo").hidden = aba !== "acervo";
        if (aba === "acervo") paginaAcervo();
        history.replaceState(null, "", "leis.html" + (aba === "acervo" ? "?aba=acervo" + (param("m") ? "&m=" + param("m") : "") : ""));
      };
      abas.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) trocar(b.getAttribute("data-aba")); });
      trocar(param("aba") === "acervo" ? "acervo" : "pol");
    }
    var lista = $("#lista"), fCasa = $("#f-casa"), fCat = $("#f-cat"), fAno = $("#f-ano"), fBusca = $("#f-busca"), total = $("#total"), mais = $("#mais");
    var POR_PAGINA = 50, limite = POR_PAGINA;
    Promise.all([carregar("normas.json"), carregar("politicos.json")]).then(function (r) {
      var normas = r[0], pol = r[1];
      var nomes = {};
      pol.forEach(function (p) { nomes[p.id] = p; });
      ORDEM_CASAS.forEach(function (c) {
        if (normas.some(function (n) { return n.casa === c; })) fCasa.insertAdjacentHTML("beforeend", '<option value="' + c + '">' + esc(CASAS[c]) + "</option>");
      });
      Array.from(new Set(normas.map(function (n) { return n.categoria; }))).sort().forEach(function (c) {
        fCat.insertAdjacentHTML("beforeend", '<option value="' + esc(c) + '">' + esc(c) + "</option>");
      });
      fCat.insertAdjacentHTML("afterbegin", '<option value="__hom">Só homenagens</option>');
      Array.from(new Set(normas.map(function (n) { return String(n.ano); }))).sort().reverse().forEach(function (a) {
        fAno.insertAdjacentHTML("beforeend", '<option value="' + esc(a) + '">' + esc(a) + "</option>");
      });
      var autor = param("autor");
      if (autor && nomes[autor]) fBusca.value = nomes[autor].nome;
      if (param("casa")) fCasa.value = param("casa");

      function render() {
        var casa = fCasa.value, cat = fCat.value, ano = fAno.value, q = semAcento(fBusca.value.trim());
        var f = normas.filter(function (n) {
          if (casa && n.casa !== casa) return false;
          if (cat === "__hom" ? HOMENAGENS.indexOf(n.categoria) < 0 : cat && n.categoria !== cat) return false;
          if (ano && String(n.ano) !== ano) return false;
          if (q) {
            var a = n.autor && nomes[n.autor] ? nomes[n.autor].nome : n.autor_nome || "";
            if (semAcento(n.ementa + " " + a + " " + n.numero).indexOf(q) < 0) return false;
          }
          return true;
        });
        total.textContent = num(f.length) + (f.length === 1 ? " norma" : " normas");
        lista.innerHTML = f.slice(0, limite).map(function (n) {
          var a = n.autor && nomes[n.autor]
            ? '<a href="politico.html?id=' + encodeURIComponent(n.autor) + '">' + esc(nomes[n.autor].nome) + "</a>"
            : esc(n.autor_nome || "Autoria não parlamentar");
          return '<li><span class="ledger__key">' + esc(dataBR(n.data)) + "</span><span>" +
            '<a href="' + esc(n.url) + '" target="_blank" rel="noopener"><strong>' + esc(n.tipo) + " nº " + esc(n.numero) + "</strong></a> — " + esc(n.ementa) +
            '<span class="ledger__sub">' + esc(CASAS[n.casa]) + " · " + a +
            ' <span class="tag' + (HOMENAGENS.indexOf(n.categoria) >= 0 ? " tag--accent" : "") + '">' + esc(n.categoria) + "</span></span></span></li>";
        }).join("") || '<li class="muted">Nenhuma norma encontrada.</li>';
        mais.hidden = f.length <= limite;
      }
      function reset() { limite = POR_PAGINA; render(); }
      [fCasa, fCat, fAno].forEach(function (el) { el.addEventListener("change", reset); });
      fBusca.addEventListener("input", reset);
      mais.addEventListener("click", function () { limite += POR_PAGINA; render(); });
      render();
    }).catch(function (e) { erro(lista, e); });
  }

  // ---------- rankings ----------
  function paginaRankings() {
    var alvo = $("#rankings"), cargos = $("#rk-cargos");
    // Cada cargo tem regras e verbas próprias, então o ranking nunca mistura cargos.
    var CARGOS_RK = { senado: "Senadores", camara: "Deputados federais", aleam: "Deputados estaduais", cmm: "Vereadores de Manaus", prefeituras: "Prefeitos" };
    carregar("politicos.json").then(function (pol) {
      var casas = ORDEM_CASAS.filter(function (c) { return CARGOS_RK[c] && pol.some(function (p) { return p.casa === c; }); });
      var casa = casas.indexOf(param("casa")) >= 0 ? param("casa") : casas[0];
      cargos.innerHTML = casas.map(function (c) {
        return '<li><button type="button" data-c="' + c + '">' + esc(CARGOS_RK[c]) + " (" + pol.filter(function (p) { return p.casa === c; }).length + ")</button></li>";
      }).join("");
      cargos.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b) return;
        casa = b.getAttribute("data-c");
        render();
      });

      var pct100 = function (v) { return Math.round(v * 100) + "%"; };
      function cotaAno(p) { var a = ultimoAno(p.cota); return a ? p.cota[a] : null; }
      function catCota(nome) {
        return function (p) { var c = cotaAno(p); return c && c.por_categoria && c.por_categoria[nome] ? c.por_categoria[nome] : null; };
      }
      var RANKINGS = [
        { grupo: "Gastos", titulo: "Maior gasto de cota", accent: true, val: function (p) { var c = cotaAno(p); return c ? c.total : null; }, fmt: reais, nota: "Ano mais recente com dados." },
        { grupo: "Gastos", titulo: "Menor gasto de cota", inverso: true, val: function (p) { var c = cotaAno(p); return c && c.total > 0 ? c.total : null; }, fmt: reais, nota: "Ano mais recente com dados." },
        { grupo: "Gastos", titulo: "Maior uso da cota disponível", accent: true, val: function (p) { var c = cotaAno(p); return c && c.uso != null ? c.uso : null; }, fmt: pct100, nota: "Gasto sobre o valor disponível no ano." },
        { grupo: "Gastos", titulo: "Mais gasto com combustível", val: catCota("Combustíveis"), fmt: reais, nota: "Ano mais recente." },
        { grupo: "Gastos", titulo: "Mais gasto com divulgação", accent: true, val: catCota("Divulgação"), fmt: reais, nota: "Publicidade, informativos, impulsionamento. Ano mais recente." },
        { grupo: "Gastos", titulo: "Mais gasto com consultoria", val: catCota("Consultoria e assessoria"), fmt: reais, nota: "Jurídica, contábil, comunicação. Ano mais recente." },
        { grupo: "Gastos", titulo: "Mais gasto com locação de veículos", val: catCota("Locação de veículos"), fmt: reais, nota: "Ano mais recente." },
        { grupo: "Gastos", titulo: "Mais gasto com passagens", val: catCota("Passagens e fretamento aéreo"), fmt: reais, nota: "Passagens e fretamento aéreo. Ano mais recente." },
        { grupo: "Gastos", titulo: "Mais gasto com escritório", val: catCota("Escritório e manutenção"), fmt: reais, nota: "Aluguel, manutenção e material. Ano mais recente." },
        { grupo: "Gastos", titulo: "Mais notas fiscais", val: function (p) { var c = cotaAno(p); return c && c.notas ? c.notas : null; }, fmt: num, nota: "Número de notas fiscais no ano mais recente." },
        { grupo: "Presença", titulo: "Mais faltas em sessões", accent: true, val: function (p) { var x = somaPresenca(p.presenca); return x.sessoes ? x.sessoes - x.presente : null; }, fmt: num, nota: "Sessões em que não registrou presença. Licença conta como falta." },
        { grupo: "Presença", titulo: "Maior presença", val: function (p) { var x = somaPresenca(p.presenca); return x.sessoes ? x.presente / x.sessoes : null; }, fmt: pct100, nota: "Sessões com presença registrada sobre o total." },
        { grupo: "Presença", titulo: "Menor presença", accent: true, inverso: true, val: function (p) { var x = somaPresenca(p.presenca); return x.sessoes ? x.presente / x.sessoes : null; }, fmt: pct100, nota: "Sessões com presença registrada sobre o total." },
        { grupo: "Votações", titulo: "Mais fiéis ao partido", val: function (p) { return p.votacoes && p.votacoes.com_orientacao ? p.votacoes.seguiu_partido / p.votacoes.com_orientacao : null; }, fmt: pct100, nota: "Votou igual à maioria do próprio partido." },
        { grupo: "Votações", titulo: "Mais independentes do partido", accent: true, inverso: true, val: function (p) { return p.votacoes && p.votacoes.com_orientacao >= 30 ? p.votacoes.seguiu_partido / p.votacoes.com_orientacao : null; }, fmt: pct100, nota: "Menor alinhamento com a maioria do partido." },
        { grupo: "Votações", titulo: "Mais votos Não", val: function (p) { return p.votacoes ? p.votacoes.nao : null; }, fmt: num, nota: "Votos Não em votações nominais." },
        { grupo: "Produção legislativa", titulo: "Mais normas aprovadas", val: function (p) { return p.metricas ? p.metricas.normas : null; }, fmt: num, nota: "Como primeiro autor, na legislatura atual." },
        { grupo: "Produção legislativa", titulo: "Mais proposições apresentadas", val: function (p) { return p.metricas ? p.metricas.proposicoes : null; }, fmt: num, nota: "Inclui requerimentos e indicações no SAPL." },
        { grupo: "Produção legislativa", titulo: "Mais homenagens aprovadas", accent: true, val: function (p) { return p.metricas ? p.metricas.homenagens : null; }, fmt: num, nota: "Títulos, datas, denominações, honrarias e utilidade pública." },
        { grupo: "Produção legislativa", titulo: "Maior parcela de homenagens", accent: true, val: function (p) { return p.metricas && p.metricas.normas >= 3 ? pctHomenagem(p) : null; }, fmt: pct100, nota: "Entre quem aprovou pelo menos 3 normas." },
        { grupo: "Produção legislativa", titulo: "Menor parcela de homenagens", inverso: true, val: function (p) { return p.metricas && p.metricas.normas >= 3 ? pctHomenagem(p) : null; }, fmt: pct100, nota: "Entre quem aprovou pelo menos 3 normas." },
        { grupo: "Produção legislativa", titulo: "Mais citado no Diário Oficial", val: function (p) { return p.diario ? p.diario.total : null; }, fmt: num, nota: "Últimos 12 meses: ALEAM, CMM e Estado." },
        { grupo: "Eleição e patrimônio", titulo: "Mais votados", val: function (p) { return p.eleicao ? p.eleicao.votos : null; }, fmt: num, nota: "Eleição mais recente que disputou." },
        { grupo: "Eleição e patrimônio", titulo: "Maior patrimônio declarado", accent: true, val: function (p) { return p.eleicao ? p.eleicao.patrimonio : null; }, fmt: reais, nota: "Bens declarados ao TSE." },
        { grupo: "Eleição e patrimônio", titulo: "Menor patrimônio declarado", inverso: true, val: function (p) { return p.eleicao && p.eleicao.patrimonio != null ? p.eleicao.patrimonio : null; }, fmt: reais, nota: "Bens declarados ao TSE." },
        { grupo: "Eleição e patrimônio", titulo: "Mais velhos", val: function (p) { return p.eleicao ? idade(p.eleicao.nascimento) : null; }, fmt: function (v) { return v + " anos"; }, nota: "Idade pela data de nascimento no TSE." },
        { grupo: "Eleição e patrimônio", titulo: "Mais jovens", inverso: true, val: function (p) { return p.eleicao ? idade(p.eleicao.nascimento) : null; }, fmt: function (v) { return v + " anos"; }, nota: "Idade pela data de nascimento no TSE." },
        { grupo: "Orçamento", titulo: "Mais emendas pagas", accent: true, val: function (p) { return p.emendas ? p.emendas.pago : null; }, fmt: reais, nota: "Deputados federais e senadores, desde 2023." },
        { grupo: "Orçamento", titulo: "Mais emendas empenhadas", val: function (p) { return p.emendas ? p.emendas.empenhado : null; }, fmt: reais, nota: "Deputados federais e senadores, desde 2023." }
      ];
      var GRUPOS = RANKINGS.map(function (r) { return r.grupo; }).filter(function (g, i, a) { return a.indexOf(g) === i; });
      var abas = $("#rk-abas"), grupoAtivo = param("grupo") || "";
      if (abas) {
        abas.innerHTML = ['<li><button type="button" data-g="">Todos</button></li>'].concat(GRUPOS.map(function (g) {
          return '<li><button type="button" data-g="' + esc(g) + '">' + esc(g) + "</button></li>";
        })).join("");
        abas.addEventListener("click", function (e) {
          var b = e.target.closest("button");
          if (!b) return;
          grupoAtivo = b.getAttribute("data-g");
          render();
        });
      }

      function linha(x) {
        return '<li><span><a href="politico.html?id=' + encodeURIComponent(x.p.id) + '">' + esc(x.p.nome) + '</a><span class="rk-sub">' +
          esc([x.p.partido, x.p.casa === "prefeituras" ? x.p.municipio : ""].filter(Boolean).join(" · ")) + '</span></span><span class="rk-v">' + x.fmt + "</span></li>";
      }
      function render() {
        [].forEach.call(cargos.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-c") === casa)); });
        history.replaceState(null, "", "?casa=" + casa + (grupoAtivo ? "&grupo=" + encodeURIComponent(grupoAtivo) : ""));
        if (abas) [].forEach.call(abas.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-g") === grupoAtivo)); });
        var base = pol.filter(function (p) { return p.casa === casa; });
        alvo.innerHTML = '<p class="kicker" style="margin-top: var(--space-4);">' + esc(CARGOS_RK[casa]) + " · " + base.length + " no cargo</p>" + GRUPOS.filter(function (g) { return !grupoAtivo || g === grupoAtivo; }).map(function (g) {
          var cards = RANKINGS.filter(function (rk) { return rk.grupo === g; }).map(function (rk) {
            var itens = base.map(function (p) { return { p: p, v: rk.val(p) }; })
              .filter(function (x) { return x.v != null && !isNaN(x.v); })
              .sort(function (a, b) { return rk.inverso ? a.v - b.v : b.v - a.v; })
              .slice(0, 10)
              .map(function (x) { x.fmt = rk.fmt(x.v); return x; });
            if (!itens.length) return "";
            return '<article class="rk-card' + (rk.accent ? " rk-card--accent" : "") + '"><p class="kicker">' + esc(g) + "</p><h3>" + esc(rk.titulo) + '</h3><p class="muted">' + esc(rk.nota) + "</p>" +
              '<ol class="rk-lista">' + itens.slice(0, 5).map(linha).join("") + "</ol>" +
              (itens.length > 5 ? '<details><summary>Ver do 6º ao ' + itens.length + 'º</summary><ol class="rk-lista" start="6" style="counter-reset: rk 5">' + itens.slice(5).map(linha).join("") + "</ol></details>" : "") +
              "</article>";
          }).join("");
          return cards ? '<section class="rk-grupo"><h2 class="h2">' + esc(g) + '</h2><div class="rk-grade">' + cards + "</div></section>" : "";
        }).join("") || '<p class="muted">Nenhum ranking com dados para esse cargo.</p>';
      }
      render();
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- gastos (cota parlamentar) ----------
  function paginaGastos() {
    var alvo = $("#gastos"), fCasa = $("#f-casa"), fAno = $("#f-ano"), fPol = $("#f-pol"), fBusca = $("#f-busca");
    Promise.all([carregar("gastos.json"), carregar("politicos.json")]).then(function (r) {
      var notas = r[0], pol = r[1], porId = {};
      pol.forEach(function (p) { porId[p.id] = p; });
      var anos = Array.from(new Set(notas.map(function (n) { return String(n.ano); }))).sort().reverse();
      anos.forEach(function (a) { fAno.insertAdjacentHTML("beforeend", '<option value="' + a + '">' + a + "</option>"); });
      var nomes = {};
      notas.forEach(function (n) { if (n.politico) nomes[n.politico] = n.politico_nome; });
      Object.keys(nomes).sort(function (a, b) { return semAcento(nomes[a]).localeCompare(semAcento(nomes[b])); }).forEach(function (id) {
        fPol.insertAdjacentHTML("beforeend", '<option value="' + esc(id) + '">' + esc(porId[id] ? porId[id].nome : nomes[id]) + "</option>");
      });
      fAno.value = param("ano") || anos[0] || "";
      if (param("casa")) fCasa.value = param("casa");
      if (param("politico")) { fPol.value = param("politico"); fAno.value = ""; }
      var limite = 50;

      function render() {
        var casa = fCasa.value, ano = fAno.value, polId = fPol.value, q = semAcento(fBusca.value.trim());
        var f = notas.filter(function (n) {
          return (!casa || n.casa === casa) && (!ano || String(n.ano) === ano) && (!polId || n.politico === polId) &&
            (!q || semAcento(n.fornecedor + " " + (n.cnpj || "") + " " + n.categoria + " " + n.politico_nome).indexOf(q) >= 0);
        });
        var total = 0, porPol = {}, porCat = {}, porMes = {}, forn = {};
        f.forEach(function (n) {
          total += n.valor;
          var k = n.politico || n.politico_nome;
          porPol[k] = (porPol[k] || 0) + n.valor;
          porCat[n.categoria] = (porCat[n.categoria] || 0) + n.valor;
          var m = n.ano + "-" + String(n.mes).padStart(2, "0");
          porMes[m] = (porMes[m] || 0) + n.valor;
          var fk = n.cnpj || n.fornecedor;
          if (!forn[fk]) forn[fk] = { nome: n.fornecedor, cnpj: n.cnpj, valor: 0, notas: 0, gabinetes: {} };
          forn[fk].valor += n.valor; forn[fk].notas++; forn[fk].gabinetes[k] = 1;
        });
        var listaForn = Object.keys(forn).map(function (k) { var x = forn[k]; x.qtd = Object.keys(x.gabinetes).length; return x; });
        var ordCat = {};
        Object.keys(porCat).sort(function (a, b) { return porCat[b] - porCat[a]; }).forEach(function (k) { ordCat[k] = porCat[k]; });
        var rank = Object.keys(porPol).sort(function (a, b) { return porPol[b] - porPol[a]; });
        var mx = porPol[rank[0]] || 1;
        var compart = listaForn.filter(function (x) { return x.qtd > 1; }).sort(function (a, b) { return b.qtd - a.qtd || b.valor - a.valor; }).slice(0, 12);
        var maiores = listaForn.sort(function (a, b) { return b.valor - a.valor; }).slice(0, 12);

        var h = '<ul class="pillars">' +
          '<li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(total) + '</span><p class="pillar__text">reembolsado' + (ano ? " em " + esc(ano) : " desde 2023") + "</p></li>" +
          '<li class="pillar"><span class="pillar__index">' + num(f.length) + '</span><p class="pillar__text">notas fiscais</p></li>' +
          '<li class="pillar"><span class="pillar__index">' + num(Object.keys(forn).length) + '</span><p class="pillar__text">fornecedores diferentes, ' + num(compart.length ? listaForn.filter(function (x) { return x.qtd > 1; }).length : 0) + " deles atendem mais de um gabinete</p></li></ul>";

        h += '<section class="section"><p class="kicker">Mês a mês</p><h2 class="h2">Evolução dos reembolsos</h2>' + colunas(porMes, reais) + "</section>";

        if (!polId) {
          h += '<section class="section"><p class="kicker">Por gabinete</p><h2 class="h2">Quem mais gastou</h2><ol class="barras barras--rank">' +
            rank.slice(0, 25).map(function (k, i) {
              var p = porId[k], nome = p ? p.nome : k;
              var uso = p && p.cota && ano && p.cota[ano] && p.cota[ano].uso != null ? " · " + Math.round(p.cota[ano].uso * 100) + "% da cota" : "";
              return '<li><span class="barras__pos">' + (i + 1) + "</span>" + (p ? '<a class="barras__rot" href="politico.html?id=' + encodeURIComponent(k) + '">' : '<span class="barras__rot">') + esc(nome) +
                ' <span class="muted">' + esc(p ? (p.partido || "") + " · " + CASAS[p.casa] : "ex-parlamentar") + uso + "</span>" + (p ? "</a>" : "</span>") +
                '<span class="barras__trilho"><span class="barras__barra" style="width:' + (porPol[k] / mx) * 100 + '%"></span></span><span class="barras__v">' + reais(porPol[k]) + "</span></li>";
            }).join("") + "</ol></section>";
        }

        h += '<section class="section"><p class="kicker">Categorias</p><h2 class="h2">Com o que se gasta</h2>' + barras(ordCat, reais, "barras--reais") + "</section>";

        h += '<section class="section"><p class="kicker">Fornecedores</p><h2 class="h2">Quem mais recebeu</h2><ul class="ledger">' + maiores.map(function (x) {
          return '<li><span class="ledger__key">' + reais(x.valor) + "</span><span>" + esc(x.nome) + '<span class="ledger__sub">' + (x.cnpj ? "CNPJ " + esc(cnpjFmt(x.cnpj)) + " · " : "") + num(x.notas) + " notas · " + x.qtd + (x.qtd === 1 ? " gabinete" : " gabinetes") + "</span></span></li>";
        }).join("") + "</ul>";
        if (compart.length && !polId) {
          h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Atendem vários gabinetes</h3><p class="muted">Atender mais de um gabinete é comum em postos e locadoras e não indica, sozinho, irregularidade.</p><ul class="ledger">' + compart.map(function (x) {
            return '<li><span class="ledger__key">' + x.qtd + ' gab.</span><span>' + esc(x.nome) + '<span class="ledger__sub">' + reais(x.valor) + (x.cnpj ? " · CNPJ " + esc(cnpjFmt(x.cnpj)) : "") + "</span></span></li>";
          }).join("") + "</ul>";
        }
        h += "</section>";

        h += '<section class="section"><p class="kicker">Notas fiscais</p><h2 class="h2">Cada gasto</h2>' +
          '<p><button class="button button--ghost no-print" type="button" id="csv">Baixar CSV (' + num(f.length) + " notas)</button></p>" +
          '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Data</th><th>Gabinete</th><th>Categoria</th><th>Fornecedor</th><th class="num">Valor</th></tr></thead><tbody>' +
          f.slice(0, limite).map(function (n) {
            return "<tr><td>" + esc(dataBR(n.data)) + "</td><td>" + esc(n.politico_nome) + "</td><td>" + esc(n.categoria) + "</td><td>" + esc(n.fornecedor) + (n.cnpj ? '<span class="ledger__sub">' + esc(cnpjFmt(n.cnpj)) + "</span>" : "") + '</td><td class="num">' + reais(n.valor) + "</td></tr>";
          }).join("") + "</tbody></table></div>" +
          (f.length > limite ? '<p><button class="button button--ghost" type="button" id="mais">Mostrar mais notas</button></p>' : "") +
          '<p class="muted">Fontes: Câmara Municipal de Manaus (SIGAE), Assembleia Legislativa do Amazonas (controle de cota parlamentar) e Câmara dos Deputados (cota parlamentar). As notas entram com até 3 meses de atraso.</p></section>';
        alvo.innerHTML = h;

        var bMais = $("#mais");
        if (bMais) bMais.addEventListener("click", function () { limite += 100; render(); });
        $("#csv").addEventListener("click", function () {
          var linhas = [["data", "casa", "gabinete", "categoria", "fornecedor", "cnpj", "valor", "documento"]].concat(f.map(function (n) {
            return [n.data, n.casa, n.politico_nome, n.categoria, n.fornecedor, n.cnpj || "", String(n.valor).replace(".", ","), n.documento || ""];
          }));
          var csv = linhas.map(function (l) { return l.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(";"); }).join("\n");
          var a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
          a.download = "cota-parlamentar-almanaque-do-poder.csv";
          a.click();
        });
      }
      [fCasa, fAno, fPol].forEach(function (el) { el.addEventListener("change", function () { limite = 50; render(); }); });
      fBusca.addEventListener("input", function () { limite = 50; render(); });
      render();
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- comparar ----------
  function paginaComparar() {
    var alvo = $("#comparacao"), fA = $("#f-a"), fB = $("#f-b");
    carregar("politicos.json").then(function (pol) {
      var ord = pol.slice().sort(function (a, b) { return ORDEM_CASAS.indexOf(a.casa) - ORDEM_CASAS.indexOf(b.casa) || semAcento(a.nome).localeCompare(semAcento(b.nome)); });
      var grupos = {};
      ord.forEach(function (p) { (grupos[p.casa] = grupos[p.casa] || []).push(p); });
      var opts = '<option value="">Escolha um político</option>' + ORDEM_CASAS.filter(function (c) { return grupos[c]; }).map(function (c) {
        return '<optgroup label="' + esc(CASAS[c]) + '">' + grupos[c].map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.nome) + (p.casa === "prefeituras" ? " (" + esc(p.municipio) + ")" : "") + "</option>";
        }).join("") + "</optgroup>";
      }).join("");
      fA.innerHTML = opts; fB.innerHTML = opts;
      var ids = (param("ids") || "").split(",");
      fA.value = ids[0] || ""; fB.value = ids[1] || "";

      function linhas(p) {
        var m = p.metricas || {}, el = p.eleicao || {}, pr = somaPresenca(p.presenca), ac = ultimoAno(p.cota);
        return [
          ["Cargo", esc(p.cargo) + (p.municipio && p.casa === "prefeituras" ? " · " + esc(p.municipio) : "")],
          ["Partido", esc(p.partido || "—")],
          ["Votos na última eleição", el.votos ? num(el.votos) + " (" + el.ano + ")" : "—"],
          ["Patrimônio declarado", el.patrimonio != null ? reais(el.patrimonio) + " (" + el.ano + ")" : "—"],
          ["Proposições apresentadas", m.proposicoes != null ? num(m.proposicoes) : "—"],
          ["Normas aprovadas", m.normas != null ? num(m.normas) : "—"],
          ["Homenagens aprovadas", m.homenagens != null ? num(m.homenagens) + (m.normas ? " (" + pct(m.homenagens, m.normas) + ")" : "") : "—"],
          ["Presença em sessões", pr.sessoes ? pct(pr.presente, pr.sessoes) : "—"],
          ["Votou com o partido", p.votacoes && p.votacoes.com_orientacao ? pct(p.votacoes.seguiu_partido, p.votacoes.com_orientacao) : "—"],
          ["Cota parlamentar (" + (ac || "—") + ")", ac ? reais(p.cota[ac].total) + (p.cota[ac].uso != null ? " · " + Math.round(p.cota[ac].uso * 100) + "% da cota" : "") : "—"],
          ["Emendas pagas desde 2023", p.emendas ? reais(p.emendas.pago) : "—"]
        ];
      }
      function render() {
        var a = pol.find(function (p) { return p.id === fA.value; }), b = pol.find(function (p) { return p.id === fB.value; });
        history.replaceState(null, "", "comparar.html" + (a || b ? "?ids=" + [a ? a.id : "", b ? b.id : ""].join(",") : ""));
        if (!a && !b) { alvo.innerHTML = '<p class="muted">Escolha dois políticos para ver os números lado a lado.</p>'; return; }
        var la = a ? linhas(a) : null, lb = b ? linhas(b) : null, base = la || lb;
        var cab = function (p) { return p ? '<a class="comparar__cab" href="politico.html?id=' + encodeURIComponent(p.id) + '">' + foto(p) + "<span>" + esc(p.nome) + "</span></a>" : "—"; };
        alvo.innerHTML = '<div class="tabela-wrap"><table class="tabela tabela--comparar"><thead><tr><th></th><th>' + cab(a) + "</th><th>" + cab(b) + "</th></tr></thead><tbody>" +
          base.map(function (l, i) {
            return "<tr><th scope=\"row\">" + esc(l[0]) + "</th><td>" + (la ? la[i][1] : "—") + "</td><td>" + (lb ? lb[i][1] : "—") + "</td></tr>";
          }).join("") + '</tbody></table></div><p class="muted">"—" indica dado não disponível para o cargo, nunca zero.</p>';
      }
      fA.addEventListener("change", render); fB.addEventListener("change", render);
      render();
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- diário oficial ----------
  var DIARIOS = { aleam: "ALEAM", cmm: "CMM", doe: "DOE-AM" };

  function itemDiario(m, comNome) {
    return '<li><span class="ledger__key">' + esc(dataBR(m.data)) + "</span><span>" +
      '<span class="tag">' + esc(m.tipo) + "</span> " +
      (comNome ? '<a href="politico.html?id=' + encodeURIComponent(m.politico) + '"><strong>' + esc(m.politico_nome) + "</strong></a> " : "") +
      '<span class="diario__trecho">' + esc(m.trecho) + "</span>" +
      '<span class="ledger__sub"><a href="' + esc(m.url) + '" target="_blank" rel="noopener">' + esc(m.diario) + ", edição " + esc(m.edicao) + "</a></span></span></li>";
  }

  function paginaDiario() {
    var alvo = $("#diario"), fFonte = $("#f-fonte"), fTipo = $("#f-tipo"), fPol = $("#f-pol"), fBusca = $("#f-busca");
    carregar("diario.json").then(function (d) {
      var ms = d.mencoes, tipos = {}, nomes = {};
      ms.forEach(function (m) { tipos[m.tipo] = (tipos[m.tipo] || 0) + 1; nomes[m.politico] = m.politico_nome; });
      Object.keys(tipos).sort().forEach(function (t) { fTipo.insertAdjacentHTML("beforeend", '<option value="' + esc(t) + '">' + esc(t) + "</option>"); });
      Object.keys(nomes).sort(function (a, b) { return semAcento(nomes[a]).localeCompare(semAcento(nomes[b])); }).forEach(function (id) {
        fPol.insertAdjacentHTML("beforeend", '<option value="' + esc(id) + '">' + esc(nomes[id]) + "</option>");
      });
      if (param("politico")) fPol.value = param("politico");
      if (param("tipo")) fTipo.value = param("tipo");
      var limite = 40;

      function render() {
        var fo = fFonte.value, ti = fTipo.value, po = fPol.value, q = semAcento(fBusca.value.trim());
        var f = ms.filter(function (m) {
          return (!fo || m.fonte === fo) && (!ti || m.tipo === ti) && (!po || m.politico === po) &&
            (!q || semAcento(m.trecho + " " + m.politico_nome).indexOf(q) >= 0);
        });
        var porTipo = {};
        f.forEach(function (m) { porTipo[m.tipo] = (porTipo[m.tipo] || 0) + 1; });
        var ordTipo = {};
        Object.keys(porTipo).sort(function (a, b) { return porTipo[b] - porTipo[a]; }).forEach(function (k) { ordTipo[k] = porTipo[k]; });
        var lidas = d.edicoes.filter(function (e) { return !fo || e.fonte === fo; });

        var h = '<ul class="pillars">' +
          '<li class="pillar"><span class="pillar__index">' + num(f.length) + '</span><p class="pillar__text">citações encontradas</p></li>' +
          '<li class="pillar"><span class="pillar__index">' + num(lidas.length) + '</span><p class="pillar__text">edições lidas nos últimos 60 dias</p></li>' +
          '<li class="pillar"><span class="pillar__index">' + num(Object.keys(f.reduce(function (o, m) { o[m.politico] = 1; return o; }, {})).length) + '</span><p class="pillar__text">políticos citados</p></li></ul>';
        h += '<section class="section"><p class="kicker">Tipos de ato</p><h2 class="h2">O que aparece</h2>' + barras(ordTipo, num) + "</section>";
        h += '<section class="section"><p class="kicker">Citações</p><h2 class="h2">Mais recentes</h2>' +
          (f.length ? '<ul class="ledger diario">' + f.slice(0, limite).map(function (m) { return itemDiario(m, true); }).join("") + "</ul>" : '<p class="muted">Nenhuma citação com esses filtros.</p>') +
          (f.length > limite ? '<p><button class="button button--ghost no-print" type="button" id="mais">Mostrar mais</button></p>' : "") + "</section>";
        h += '<section class="section"><p class="kicker">Edições lidas</p><h2 class="h2">Diários consultados</h2><ul class="ledger">' +
          lidas.slice(0, 15).map(function (e) {
            return '<li><span class="ledger__key">' + esc(dataBR(e.data)) + '</span><span><a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.nome) + ", edição " + esc(e.numero) + "</a>" +
              '<span class="ledger__sub">' + (e.mencoes ? num(e.mencoes) + (e.mencoes === 1 ? " citação" : " citações") : "nenhuma citação") + "</span></span></li>";
          }).join("") + "</ul></section>";
        alvo.innerHTML = h;
        var b = $("#mais");
        if (b) b.addEventListener("click", function () { limite += 60; render(); });
      }
      [fFonte, fTipo, fPol].forEach(function (el) { el.addEventListener("change", function () { limite = 40; render(); }); });
      fBusca.addEventListener("input", function () { limite = 40; render(); });
      render();
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- municípios ----------
  function paginaMunicipio() {
    var alvo = $("#municipio"), fMun = $("#f-mun");
    Promise.all([carregar("municipios.json"), carregar("politicos.json")]).then(function (r) {
      var mun = r[0], pol = r[1];
      Object.keys(mun).forEach(function (k) { fMun.insertAdjacentHTML("beforeend", '<option value="' + esc(k) + '">' + esc(mun[k].nome) + "</option>"); });
      fMun.value = param("m") && mun[param("m")] ? param("m") : "manaus";
      function pessoaLink(x) { return '<a href="politico.html?id=' + encodeURIComponent(x.pessoa) + '">' + esc(x.nome) + "</a>"; }
      function render() {
        var k = fMun.value, m = mun[k];
        history.replaceState(null, "", "municipio.html?m=" + k);
        document.title = m.nome + " · Almanaque do Poder";
        var anos = Object.keys(m.eleicoes).sort().reverse(), ult = m.eleicoes[anos[0]];
        var prefeito = pol.filter(function (p) { return p.casa === "prefeituras" && slugJS(p.municipio || "") === k; });
        var vereadoresAtuais = k === "manaus" ? pol.filter(function (p) { return p.casa === "cmm"; }) : null;
        var h = '<section class="section"><p class="kicker">Em exercício</p><h2 class="h2">' + esc(m.nome) + " hoje</h2>";
        h += '<ul class="cards">' + prefeito.map(function (p) {
          return '<li><a class="card" href="politico.html?id=' + encodeURIComponent(p.id) + '">' + foto(p) + '<span class="card__corpo"><span class="card__nome">' + esc(p.nome) + '</span><span class="card__meta">' + esc(p.cargo) + '</span><span class="card__partido">' + esc(p.partido || "") + "</span></span></a></li>";
        }).join("") + (ult && ult.vice.length ? ult.vice.map(function (v) {
          return '<li><a class="card" href="politico.html?id=' + encodeURIComponent(v.pessoa) + '">' + foto({ nome: v.nome, foto: "data/fotos/" + v.pessoa + ".webp" }) + '<span class="card__corpo"><span class="card__nome">' + esc(v.nome) + '</span><span class="card__meta">Vice-prefeito(a) eleito(a) em ' + anos[0] + '</span><span class="card__partido">' + esc(v.partido || "") + "</span></span></a></li>";
        }).join("") : "") + "</ul>";
        h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Vereadores' + (vereadoresAtuais ? " em exercício" : " eleitos em " + anos[0]) + "</h3>";
        if (vereadoresAtuais) {
          h += '<ul class="cards">' + vereadoresAtuais.sort(function (a, b) { return semAcento(a.nome).localeCompare(semAcento(b.nome)); }).map(function (p) {
            return '<li><a class="card" href="politico.html?id=' + encodeURIComponent(p.id) + '">' + foto(p) + '<span class="card__corpo"><span class="card__nome">' + esc(p.nome) + '</span><span class="card__meta">' + esc(p.cargo) + '</span><span class="card__partido">' + esc(p.partido || "") + "</span></span></a></li>";
          }).join("") + "</ul>";
        } else {
          h += '<ul class="cards">' + ult.vereadores.map(function (v) {
            return '<li><a class="card" href="politico.html?id=' + encodeURIComponent(v.pessoa) + '">' + foto({ nome: v.nome, foto: "data/fotos/" + v.pessoa + ".webp" }) + '<span class="card__corpo"><span class="card__nome">' + esc(v.nome) + '</span><span class="card__meta">' + (v.votos != null ? num(v.votos) + " votos" : "Vereador(a)") + '</span><span class="card__partido">' + esc(v.partido || "") + "</span></span></a></li>";
          }).join("") + '</ul><p class="muted">A lista mostra os eleitos em ' + anos[0] + ". Suplentes que assumiram depois não aparecem: a Câmara Municipal não publica dados abertos.</p>";
        }
        h += "</section>";

        h += '<div id="leis-mun"></div>';
        h += '<section class="section"><p class="kicker">Linha do tempo</p><h2 class="h2">Prefeitos e câmaras eleitos</h2><ol class="linha">' + anos.map(function (a) {
          var e = m.eleicoes[a], partidos = {};
          e.vereadores.forEach(function (v) { partidos[v.partido || "?"] = (partidos[v.partido || "?"] || 0) + 1; });
          var ordem = Object.keys(partidos).sort(function (x, y) { return partidos[y] - partidos[x]; });
          return '<li class="linha__item"><span class="linha__ano">' + a + '</span><div class="linha__corpo">' +
            '<p class="linha__pref"><strong>Prefeito(a):</strong> ' + (e.prefeito.length ? e.prefeito.map(function (x) { return pessoaLink(x) + " (" + esc(x.partido || "") + (x.votos ? ", " + num(x.votos) + " votos" : "") + ")"; }).join("; ") : "sem registro de eleito") +
            (e.vice.length ? ' · <span class="muted">vice: ' + e.vice.map(pessoaLink).join("; ") + "</span>" : "") + "</p>" +
            '<p class="linha__camara"><strong>Câmara:</strong> ' + e.vereadores.length + " vereadores · " + num(e.candidatos) + " candidaturas</p>" +
            '<p class="linha__partidos">' + ordem.map(function (pt) { return '<span class="tag">' + esc(pt) + " " + partidos[pt] + "</span>"; }).join(" ") + "</p>" +
            "<details><summary>Ver os vereadores eleitos</summary><ul class=\"linha__lista\">" + e.vereadores.map(function (v) {
              return "<li>" + pessoaLink(v) + ' <span class="muted">' + esc(v.partido || "") + (v.votos != null ? " · " + num(v.votos) + " votos" : "") + "</span></li>";
            }).join("") + "</ul></details></div></li>";
        }).join("") + '</ol><p class="muted">Fonte: TSE, candidaturas e resultado de cada eleição municipal desde 2000. Cassações e posses de suplentes depois da eleição não aparecem.</p></section>';
        alvo.innerHTML = h;
        carregar("leis/resumo.json").then(function (res) {
          var box = $("#leis-mun"), x = res[k];
          if (!box) return;
          if (!x) {
            box.outerHTML = '<section class="section"><p class="kicker">Leis</p><h2 class="h2">Leis do município</h2><p class="prose">Nenhuma lei de ' + esc(m.nome) + " encontrada no SAPL da câmara nem no Diário Oficial dos Municípios.</p></section>";
            return;
          }
          var obrigado = x.populacao && x.populacao > 20000;
          var doc = function (rot, d, extra) {
            return '<li><span class="ledger__key">' + rot + "</span><span>" + (d ? '<a href="' + esc(d[4]) + '" target="_blank" rel="noopener">' + nomeLei(d[0], d[1], d[2]) + "</a>" + (d[3] ? '<span class="ledger__sub">' + esc(d[3]) + "</span>" : "") : "<strong>Não encontrada no acervo.</strong>" + (extra || "")) + "</span></li>";
          };
          box.outerHTML = '<section class="section"><p class="kicker">Leis</p><h2 class="h2">Leis do município</h2>' +
            '<ul class="pillars"><li class="pillar"><span class="pillar__index">' + num(x.total) + '</span><p class="pillar__text">leis no acervo (' + esc(x.fontes.join(" e ")) + ")</p></li>" +
            (x.classificadas ? '<li class="pillar"><span class="pillar__index pillar__index--accent">' + pct(x.homenagens, x.classificadas) + '</span><p class="pillar__text">são homenagens: títulos, datas comemorativas, nomes de rua e utilidade pública</p></li>' : "") +
            (x.populacao ? '<li class="pillar"><span class="pillar__index">' + num(x.populacao) + '</span><p class="pillar__text">habitantes (Censo 2022)</p></li>' : "") + "</ul>" +
            '<ul class="ledger">' + doc("Lei Orgânica", x.lei_organica) +
            doc("Plano Diretor", x.plano_diretor, obrigado ? ' <span class="ledger__sub">Com mais de 20 mil habitantes, o município é obrigado a ter plano diretor (Estatuto da Cidade, art. 41). Ele pode existir sem ter sido publicado nas fontes consultadas.</span>' : "") + "</ul>" +
            '<h3 class="sub-graf">Leis por ano</h3>' + colunas(x.por_ano, num) +
            '<h3 class="sub-graf">Mais recentes</h3><ul class="ledger ledger--normas">' + x.ultimas.map(function (r) { return linhaLei(r); }).join("") + "</ul>" +
            '<p><a class="button button--ghost" href="leis.html?aba=acervo&m=' + k + '">Ver todas as leis de ' + esc(m.nome) + "</a></p></section>";
        }).catch(function () {});
      }
      fMun.addEventListener("change", render);
      render();
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- tribunais ----------
  function paginaTribunais() {
    var alvo = $("#tribunais"), abas = $("#abas-trib"), fBusca = $("#f-busca");
    carregar("tribunais.json").then(function (tr) {
      var orgs = Object.keys(tr), ativo = param("orgao") && tr[param("orgao")] ? param("orgao") : orgs[0];
      abas.innerHTML = orgs.map(function (o) { return '<li><button type="button" data-o="' + o + '">' + esc(o.toUpperCase().replace("TREAM", "TRE-AM").replace("TCEAM", "TCE-AM")) + "</button></li>"; }).join("");
      abas.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) { ativo = b.getAttribute("data-o"); render(); } });
      fBusca.addEventListener("input", render);
      function render() {
        [].forEach.call(abas.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-o") === ativo)); });
        history.replaceState(null, "", "tribunais.html?orgao=" + ativo);
        var o = tr[ativo], q = semAcento(fBusca.value.trim());
        var ms = o.membros.filter(function (x) { return !q || semAcento(x.nome + " " + x.cargo + " " + x.lotacao).indexOf(q) >= 0; });
        var comValor = o.membros.filter(function (x) { return x.media_bruta; });
        var media = comValor.length ? comValor.reduce(function (t, x) { return t + x.media_bruta; }, 0) / comValor.length : null;
        var maior = comValor.reduce(function (m, x) { return x.maior_mes > (m.maior_mes || 0) ? x : m; }, {});
        var h = '<section class="section"><p class="kicker">' + esc(ativo.toUpperCase()) + '</p><h2 class="h2">' + esc(o.nome) + "</h2>" +
          '<ul class="pillars"><li class="pillar"><span class="pillar__index">' + num(o.membros.length) + '</span><p class="pillar__text">membros' + (o.meses.length ? " com contracheque publicado" : "") + "</p></li>" +
          (media ? '<li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(media) + '</span><p class="pillar__text">média mensal bruta por membro (' + o.meses.length + " meses)</p></li>" : "") +
          (maior.maior_mes ? '<li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(maior.maior_mes) + '</span><p class="pillar__text">maior contracheque: ' + esc(maior.nome) + " (" + esc(mesAno(maior.maior_mes_ref)) + ")</p></li>" : "") + "</ul>" +
          (o.nota ? '<p class="nota">' + esc(o.nota) + "</p>" : "") + "</section>";
        h += '<section class="section"><p class="kicker">Membros</p><h2 class="h2">Quem são e quanto recebem</h2><div class="tabela-wrap"><table class="tabela"><thead><tr><th>Nome</th><th>Cargo e lotação</th>' +
          (o.meses.length ? '<th class="num">Média mensal bruta</th><th class="num">Total no período</th><th class="num">Diárias</th><th class="num">Maior mês</th>' : "") + "</tr></thead><tbody>" +
          ms.map(function (x) {
            return "<tr><td><strong>" + esc(x.nome) + "</strong>" + (x.rubricas && Object.keys(x.rubricas).length ? '<span class="ledger__sub">' + Object.keys(x.rubricas).slice(0, 3).map(function (k) { return esc(k.length > 40 ? k.slice(0, 40) + "…" : k) + ": " + reais(x.rubricas[k]); }).join(" · ") + "</span>" : "") + "</td><td>" + esc(x.cargo) + (x.lotacao ? '<span class="ledger__sub">' + esc(x.lotacao) + "</span>" : "") + "</td>" +
              (o.meses.length ? '<td class="num">' + (x.media_bruta ? reais(x.media_bruta) : "—") + '</td><td class="num">' + reais(x.bruto) + '</td><td class="num">' + (x.diarias ? reais(x.diarias) : "—") + '</td><td class="num">' + reais(x.maior_mes) + "</td>" : "") + "</tr>";
          }).join("") + "</tbody></table></div>" +
          '<p class="muted">Fonte: <a href="' + esc(o.fonte) + '" target="_blank" rel="noopener">' + esc(o.fonte) + "</a>" + (o.meses.length ? ", meses de " + esc(mesAno(o.meses[0])) + " a " + esc(mesAno(o.meses[o.meses.length - 1])) : "") + ". Valores brutos: subsídio mais indenizações, auxílios e gratificações, antes dos descontos.</p></section>";
        alvo.innerHTML = h;
      }
      render();
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- financiamento de campanhas ----------
  function paginaCampanhas() {
    var alvoD = $("#doadores"), alvoC = $("#candidatos"), fTipo = $("#f-tipo"), fBusca = $("#f-busca"), fAno = $("#c-ano"), fCargo = $("#c-cargo"), fMun = $("#c-mun");
    carregar("doadores.json").then(function (dd) {
      var tipos = Array.from(new Set(dd.doadores.map(function (g) { return g.tipo; }))).sort();
      tipos.forEach(function (t) { fTipo.insertAdjacentHTML("beforeend", '<option value="' + esc(t) + '">' + esc(t) + "</option>"); });
      var unicos = function (i) { return Array.from(new Set(dd.candidatos.map(function (r) { return r[i]; }))).sort(function (a, b) { return String(a).localeCompare(String(b), "pt"); }); };
      unicos(2).reverse().forEach(function (a) { fAno.insertAdjacentHTML("beforeend", '<option value="' + a + '">' + a + "</option>"); });
      unicos(3).forEach(function (a) { fCargo.insertAdjacentHTML("beforeend", '<option value="' + esc(a) + '">' + esc(a) + "</option>"); });
      unicos(4).forEach(function (a) { fMun.insertAdjacentHTML("beforeend", '<option value="' + esc(a) + '">' + esc(a) + "</option>"); });
      function renderD() {
        var t = fTipo.value, q = semAcento(fBusca.value.trim());
        var f = dd.doadores.filter(function (g) { return (!t || g.tipo === t) && (!q || semAcento(g.nome + " " + g.candidatos.map(function (c) { return c[1]; }).join(" ")).indexOf(q) >= 0); });
        alvoD.innerHTML = '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Financiador</th><th>Tipo</th><th class="num">Total doado</th><th class="num">Candidatos</th><th>Principais beneficiados</th></tr></thead><tbody>' +
          f.slice(0, 100).map(function (g) {
            return "<tr><td><strong>" + esc(g.nome) + '</strong><span class="ledger__sub">' + g.anos.join(", ") + "</span></td><td>" + esc(g.tipo) + '</td><td class="num">' + reais(g.total) + '</td><td class="num">' + num(g.n) + "</td><td>" +
              g.candidatos.slice(0, 4).map(function (c) { return '<a href="politico.html?id=' + encodeURIComponent(c[0]) + '">' + esc(c[1]) + "</a> " + '<span class="muted">' + c[2] + ", " + reais(c[3]) + "</span>"; }).join("<br>") + "</td></tr>";
          }).join("") + "</tbody></table></div>" + (f.length ? "" : '<p class="muted">Nenhum financiador com esses filtros.</p>');
      }
      function renderC() {
        var a = fAno.value, cg = fCargo.value, mu = fMun.value;
        var f = dd.candidatos.filter(function (r) { return (!a || String(r[2]) === a) && (!cg || r[3] === cg) && (!mu || r[4] === mu); });
        alvoC.innerHTML = '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Candidato</th><th>Eleição</th><th class="num">Arrecadado</th><th class="num">Dinheiro público</th><th class="num">Próprio bolso</th></tr></thead><tbody>' +
          f.slice(0, 50).map(function (r) {
            return '<tr><td><a href="politico.html?id=' + encodeURIComponent(r[0]) + '"><strong>' + esc(r[1]) + "</strong></a>" + '<span class="ledger__sub">' + esc(r[5]) + "</span></td><td>" + r[2] + " · " + esc(r[3]) + (r[4] !== "Amazonas" ? '<span class="ledger__sub">' + esc(r[4]) + "</span>" : "") +
              '</td><td class="num">' + reais(r[6]) + '</td><td class="num">' + pct(r[7], r[6]) + '</td><td class="num">' + pct(r[8], r[6]) + "</td></tr>";
          }).join("") + "</tbody></table></div>";
      }
      [fTipo].forEach(function (el) { el.addEventListener("change", renderD); });
      fBusca.addEventListener("input", renderD);
      [fAno, fCargo, fMun].forEach(function (el) { el.addEventListener("change", renderC); });
      renderD(); renderC();
    }).catch(function (e) { erro(alvoD, e); });
  }

  // ---------- fontes (página sobre) ----------
  function paginaSobre() {
    var alvo = $("#fontes");
    if (!alvo) return;
    carregar("meta.json").then(function (meta) {
      alvo.innerHTML = meta.fontes.concat(meta.ajustes_executivo || []).map(function (f) {
        return '<li><span class="ledger__key">' + esc(f.atualizado_em ? dataBR(f.atualizado_em) : "Ajuste") + '</span><span><a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.nome) + "</a></span></li>";
      }).join("");
    }).catch(function () {});
  }

  // ---------- partidos ----------
  // Pesos do índice de poder: cada mandato vigente vale pontos pelo alcance do cargo.
  var PESO_PODER = [
    ["Governador(a)", 10], ["Senador(a)", 6], ["Prefeito(a) de Manaus", 6], ["Deputado(a) federal", 4], ["Vice-governador(a)", 3],
    ["Deputado(a) estadual", 2], ["Prefeito(a), outros municípios", 2], ["Vereador(a) de Manaus", 1], ["Vereador(a), outros municípios", 0.25]
  ];
  function tipoMandato(p) {
    if (p.casa === "prefeituras") return p.municipio === "Manaus" ? "Prefeito(a) de Manaus" : "Prefeito(a), outros municípios";
    return p.cargo;
  }
  function siglaAtual(s, cfg) {
    s = cfg.alias[s] || s;
    while (cfg.sucessora[s]) s = cfg.sucessora[s];
    return s;
  }
  // Junta mandatos vigentes, histórico e campanhas num resumo por partido.
  function resumoPartidos(cfg, pol) {
    var peso = {}, out = {};
    PESO_PODER.forEach(function (x) { peso[x[0]] = x[1]; });
    function novo(s) {
      return out[s] = out[s] || { sigla: s, dados: cfg.partidos[s] || null, mandatos: [], porTipo: {}, pontos: 0, cota: 0, emendas: 0 };
    }
    Object.keys(cfg.partidos).forEach(novo);
    pol.forEach(function (p) {
      if (!p.partido) return;
      var r = novo(siglaAtual(p.partido, cfg)), t = tipoMandato(p);
      r.mandatos.push(p);
      r.porTipo[t] = (r.porTipo[t] || 0) + 1;
      r.pontos += peso[t] || 0;
      r.cota += totalCota(p) || 0;
      r.emendas += p.emendas ? p.emendas.pago || 0 : 0;
    });
    Object.keys(out).forEach(function (s) {
      var r = out[s], vi = r.dados ? r.dados.vereadores_interior : 0;
      if (vi) { r.porTipo["Vereador(a), outros municípios"] = vi; r.pontos += vi * peso["Vereador(a), outros municípios"]; }
      r.vigentes = r.mandatos.length + vi;
      var pa = r.dados ? r.dados.por_ano : {};
      r.eleitosAno = function (a) { return pa[a] ? pa[a][1] : 0; };
      var anosCamp = Object.keys(r.dados ? r.dados.campanha : {}).sort();
      r.ultCamp = anosCamp.length ? [anosCamp[anosCamp.length - 1], r.dados.campanha[anosCamp[anosCamp.length - 1]]] : null;
    });
    var lista = Object.keys(out).map(function (s) { return out[s]; }).filter(function (r) { return r.vigentes || (r.dados && r.dados.candidaturas); });
    lista.sort(function (a, b) { return b.pontos - a.pontos || b.vigentes - a.vigentes; });
    lista.forEach(function (r, i) { r.posicao = r.pontos ? i + 1 : null; });
    return lista;
  }
  function pontosFmt(v) { return v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }); }

  function paginaPartidos() {
    var alvo = $("#partidos"), s = param("p");
    Promise.all([carregar("partidos.json"), carregar("politicos.json")]).then(function (r) {
      var cfg = r[0], lista = resumoPartidos(cfg, r[1]);
      if (s) return paginaPartido(alvo, cfg, lista, s);
      var anos = [];
      lista.forEach(function (x) { Object.keys(x.dados ? x.dados.por_ano : {}).forEach(function (a) { if (anos.indexOf(a) < 0) anos.push(a); }); });
      anos.sort().reverse();
      var geral = anos.filter(function (a) { return +a % 4 === 2; })[0], mun = anos.filter(function (a) { return +a % 4 === 0; })[0];
      var COLS = [
        ["pontos", "Índice de poder", function (x) { return x.pontos; }, pontosFmt],
        ["vigentes", "Mandatos vigentes", function (x) { return x.vigentes; }, num],
        ["geral", "Eleitos em " + geral, function (x) { return x.eleitosAno(geral); }, num],
        ["mun", "Eleitos em " + mun, function (x) { return x.eleitosAno(mun); }, num],
        ["hist", "Eleitos desde 2000", function (x) { return x.dados ? x.dados.eleitos : 0; }, num],
        ["camp", "Arrecadação na última campanha", function (x) { return x.ultCamp ? x.ultCamp[1][0] : 0; }, function (v, x) { return v ? reais(v) + ' <span class="ledger__sub">' + x.ultCamp[0] + "</span>" : "—"; }],
        ["cota", "Cota gasta pelos mandatos atuais", function (x) { return x.cota; }, function (v) { return v ? reais(v) : "—"; }]
      ];
      alvo.innerHTML = '<form class="filtros" onsubmit="return false"><label><span>Ordenar por</span><select id="f-ordem">' +
        COLS.map(function (c) { return '<option value="' + c[0] + '">' + esc(c[1]) + "</option>"; }).join("") + '</select></label></form><div id="pt-tabela"></div>' +
        '<section class="section"><p class="kicker">Método</p><h2 class="h2">Como o índice de poder é calculado</h2>' +
        '<p class="prose">Cada mandato vigente soma pontos conforme o alcance do cargo. O partido de cada político é o atual, informado pela casa legislativa ou pelo governo. Vereadores fora de Manaus entram pelo partido com que foram eleitos em ' + esc(cfg.ano_municipal) + '. Siglas extintas ou renomeadas contam para a sucessora (por exemplo, PMDB para MDB, e DEM e PSL para União).</p>' +
        '<ul class="ledger">' + PESO_PODER.map(function (x) { return '<li><span class="ledger__key">' + pontosFmt(x[1]) + (x[1] === 1 ? " ponto" : " pontos") + "</span><span>" + esc(x[0]) + "</span></li>"; }).join("") + "</ul>" +
        '<p class="muted">Os pesos são uma escolha editorial do Almanaque. As outras colunas permitem comparar sem eles. Fonte: TSE (candidaturas desde 2000 e prestação de contas desde 2018), casas legislativas e governo.</p></section>';
      var sel = $("#f-ordem");
      if (COLS.some(function (c) { return c[0] === param("ordem"); })) sel.value = param("ordem");
      function render() {
        var col = COLS.filter(function (c) { return c[0] === sel.value; })[0];
        history.replaceState(null, "", "?ordem=" + col[0]);
        var l = lista.slice().sort(function (a, b) { return col[2](b) - col[2](a); });
        var mx = col[2](l[0]) || 1;
        $("#pt-tabela").innerHTML = '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>#</th><th>Partido</th>' +
          COLS.map(function (c) { return '<th class="num">' + esc(c[1]) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          l.map(function (x, i) {
            return "<tr><td>" + (i + 1) + '</td><td><a href="partidos.html?p=' + encodeURIComponent(x.sigla) + '"><strong>' + esc(x.sigla) + "</strong></a>" +
              (x.dados && x.dados.siglas.length > 1 ? '<span class="ledger__sub">' + esc(x.dados.siglas.filter(function (g) { return g !== x.sigla; }).join(", ")) + "</span>" : "") +
              '<span class="pt-barra" style="width:' + Math.max(col[2](x) / mx * 100, 0) + '%"></span></td>' +
              COLS.map(function (c) { return '<td class="num">' + c[3](c[2](x), x) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div>";
      }
      sel.addEventListener("change", render);
      render();
    }).catch(function (e) { erro(alvo, e); });
  }

  function paginaPartido(alvo, cfg, lista, s) {
    var x = lista.filter(function (r) { return r.sigla === s; })[0] || lista.filter(function (r) { return r.sigla === siglaAtual(s, cfg); })[0];
    if (!x) { alvo.innerHTML = '<p class="aviso">Partido não encontrado. <a href="partidos.html">Ver todos os partidos</a>.</p>'; return; }
    var d = x.dados || { siglas: [x.sigla], candidaturas: 0, eleitos: 0, por_ano: {}, por_cargo: {}, campanha: {}, slug: slugJS(x.sigla) };
    document.title = x.sigla + " · Partidos · Almanaque do Poder";
    var antigas = d.siglas.filter(function (g) { return g !== x.sigla; });
    var anos = Object.keys(d.por_ano).sort().reverse();
    var hero = $(".hero");
    hero.innerHTML = '<p class="kicker"><a href="partidos.html">Partidos</a></p><h1 class="display">' + esc(x.sigla) + "</h1>" +
      '<p class="lede">' + (antigas.length ? "Inclui o histórico de " + esc(antigas.join(", ")) + ", siglas antigas ou incorporadas. " : "") +
      (anos.length ? "Candidaturas no Amazonas desde " + anos[anos.length - 1] + "." : "Sem candidaturas registradas no histórico do TSE.") + "</p>";
    var h = '<p class="no-print acoes-perfil"><button class="button button--ghost" type="button" onclick="window.print()">Exportar PDF</button></p>';
    var cr = [];
    if (x.posicao) cr.push([x.posicao + "º", "no índice de poder (" + pontosFmt(x.pontos) + " pontos)"]);
    cr.push([num(x.vigentes), "mandatos vigentes"]);
    cr.push([num(d.eleitos), "eleitos desde " + (anos[anos.length - 1] || "2000")]);
    cr.push([num(d.candidaturas), "candidaturas"]);
    if (anos[0]) cr.push([num(d.por_ano[anos[0]][2]), "votos nominais em " + anos[0]]);
    if (x.ultCamp) cr.push([reais(x.ultCamp[1][0]), "arrecadados pelos candidatos em " + x.ultCamp[0]]);
    h += crachaHTML(cr);

    // Mandatos vigentes
    h += '<section class="section"><p class="kicker">Com mandato</p><h2 class="h2">Quem exerce mandato pelo partido</h2>';
    if (!x.vigentes) h += '<p class="prose">Nenhum mandato vigente registrado.</p>';
    else {
      h += barras(x.porTipo, num, "", 12);
      var porTipo = {};
      x.mandatos.forEach(function (p) { (porTipo[tipoMandato(p)] = porTipo[tipoMandato(p)] || []).push(p); });
      PESO_PODER.forEach(function (t) {
        var l = porTipo[t[0]];
        if (!l) return;
        h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">' + esc(t[0]) + " (" + l.length + ')</h3><ul class="ledger">' + l.map(function (p) {
          return '<li><span class="ledger__key">' + esc(p.casa === "prefeituras" ? p.municipio : CASAS[p.casa] || "") + '</span><span><a href="politico.html?id=' + encodeURIComponent(p.id) + '">' + esc(p.nome) + "</a></span></li>";
        }).join("") + "</ul>";
      });
      if (d.vereadores_interior) h += '<div id="pt-vereadores"></div>';
    }
    h += "</section>";

    // Histórico
    if (anos.length) {
      var eleitosAno = {};
      anos.slice().reverse().forEach(function (a) { eleitosAno[a] = d.por_ano[a][1]; });
      h += '<section class="section"><p class="kicker">Histórico</p><h2 class="h2">Eleição a eleição</h2>' +
        '<h3 class="eleitos__cargo">Eleitos por ano</h3>' + colunas(eleitosAno, num) +
        '<div class="tabela-wrap" style="margin-top: var(--space-3);"><table class="tabela"><thead><tr><th>Ano</th><th>Sigla usada</th><th class="num">Candidaturas</th><th class="num">Eleitos</th><th class="num">Votos nominais</th></tr></thead><tbody>' +
        anos.map(function (a) { var v = d.por_ano[a]; return "<tr><td>" + a + "</td><td>" + esc(v[3].join(", ")) + '</td><td class="num">' + num(v[0]) + '</td><td class="num">' + num(v[1]) + '</td><td class="num">' + num(v[2]) + "</td></tr>"; }).join("") +
        "</tbody></table></div>" +
        '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Por cargo</h3><div class="tabela-wrap"><table class="tabela"><thead><tr><th>Cargo</th><th class="num">Candidaturas</th><th class="num">Eleitos</th><th class="num">Taxa de vitória</th></tr></thead><tbody>' +
        Object.keys(d.por_cargo).sort(function (a, b) { return d.por_cargo[b][0] - d.por_cargo[a][0]; }).map(function (c) {
          var v = d.por_cargo[c];
          return "<tr><td>" + esc(c) + '</td><td class="num">' + num(v[0]) + '</td><td class="num">' + num(v[1]) + '</td><td class="num">' + pct(v[1], v[0]) + "</td></tr>";
        }).join("") + "</tbody></table></div>" +
        '<p class="muted">Fonte: TSE, candidaturas no Amazonas desde 2000. Os arquivos do TSE de 2000 e 2004 não marcam a maior parte dos vereadores eleitos, então esses anos aparecem com menos eleitos.</p></section>';
    }

    // Dinheiro
    var anosC = Object.keys(d.campanha).sort().reverse();
    if (anosC.length || x.cota || x.emendas) {
      h += '<section class="section"><p class="kicker">Dinheiro</p><h2 class="h2">Campanhas e gastos dos mandatos</h2>';
      if (x.cota || x.emendas) {
        h += '<ul class="pillars">' +
          (x.cota ? '<li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(x.cota) + '</span><p class="pillar__text">de cota parlamentar gasta pelos mandatos atuais do partido, desde 2023</p></li>' : "") +
          (x.emendas ? '<li class="pillar"><span class="pillar__index pillar__index--accent pillar__index--valor">' + reais(x.emendas) + '</span><p class="pillar__text">em emendas pagas a deputados federais e senadores do partido</p></li>' : "") + "</ul>";
        var porCota = {};
        x.mandatos.forEach(function (p) { var t = totalCota(p); if (t) porCota[p.nome] = t; });
        var ord = {};
        Object.keys(porCota).sort(function (a, b) { return porCota[b] - porCota[a]; }).forEach(function (k) { ord[k] = porCota[k]; });
        if (Object.keys(ord).length) h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Cota parlamentar por político</h3>' + barras(ord, reais, "barras--reais", 15);
      }
      if (anosC.length) {
        h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Campanhas dos candidatos do partido</h3><div class="tabela-wrap"><table class="tabela"><thead><tr><th>Ano</th><th class="num">Campanhas com contas</th><th class="num">Arrecadado</th><th class="num">Dinheiro público</th><th class="num">Gasto contratado</th></tr></thead><tbody>' +
          anosC.map(function (a) { var v = d.campanha[a]; return "<tr><td>" + a + '</td><td class="num">' + num(v[3]) + '</td><td class="num">' + reais(v[0]) + '</td><td class="num">' + pct(v[1], v[0]) + '</td><td class="num">' + reais(v[2]) + "</td></tr>"; }).join("") +
          '</tbody></table></div><p class="muted">Fonte: TSE, prestação de contas dos candidatos (2018 em diante). Não inclui as contas dos diretórios partidários. Dinheiro público é fundo eleitoral e fundo partidário.</p>';
      }
      h += "</section>";
    }
    h += '<section class="section" id="pt-eleitos"><p class="kicker">Eleitos</p><h2 class="h2">Todos os eleitos pelo partido</h2><p class="muted">Carregando…</p></section>';
    alvo.innerHTML = h;

    carregar("partidos/" + d.slug + ".json").catch(function () { return []; }).then(function (el) {
      var box = $("#pt-vereadores");
      if (box) {
        var v = el.filter(function (e) { return e[4] === cfg.ano_municipal && e[2] === "Vereador" && e[3] !== "Manaus"; }), porMun = {};
        v.forEach(function (e) { (porMun[e[3]] = porMun[e[3]] || []).push(e); });
        box.outerHTML = '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Vereador(a), outros municípios (' + v.length + ")</h3>" +
          "<details><summary>Ver os eleitos em " + cfg.ano_municipal + ' por município</summary><ul class="ledger">' + Object.keys(porMun).sort(function (a, b) { return a.localeCompare(b, "pt"); }).map(function (m) {
            return '<li><span class="ledger__key">' + esc(m) + "</span><span>" + porMun[m].map(function (e) { return '<a href="politico.html?id=' + encodeURIComponent(e[0]) + '">' + esc(e[1]) + "</a>"; }).join(", ") + "</span></li>";
          }).join("") + '</ul></details><p class="muted">Partido com que foram eleitos. Câmaras do interior não publicam trocas de partido em formato aberto.</p>';
      }
      var sec = $("#pt-eleitos");
      if (!el.length) { sec.outerHTML = ""; return; }
      var cargos = Array.from(new Set(el.map(function (e) { return e[2]; }))).sort();
      var anosE = Array.from(new Set(el.map(function (e) { return e[4]; }))).sort().reverse();
      sec.innerHTML = '<p class="kicker">Eleitos</p><h2 class="h2">Todos os eleitos pelo partido (' + num(el.length) + ")</h2>" +
        '<form class="filtros" onsubmit="return false"><label><span>Cargo</span><select id="pe-cargo"><option value="">Todos</option>' + cargos.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + "</option>"; }).join("") + "</select></label>" +
        '<label><span>Ano</span><select id="pe-ano"><option value="">Todos</option>' + anosE.map(function (a) { return '<option value="' + a + '">' + a + "</option>"; }).join("") + "</select></label>" +
        '<label><span>Nome ou município</span><input id="pe-busca" type="search"></label></form>' +
        '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Ano</th><th>Nome</th><th>Cargo</th><th>Onde</th><th>Sigla</th><th class="num">Votos</th></tr></thead><tbody id="pe-corpo"></tbody></table></div>' +
        '<p class="no-print"><button class="button button--ghost" type="button" id="pe-mais">Mostrar mais</button></p>';
      var limite = 100, fC = $("#pe-cargo"), fA = $("#pe-ano"), fB = $("#pe-busca");
      function render() {
        var b = semAcento(fB.value);
        var f = el.filter(function (e) { return (!fC.value || e[2] === fC.value) && (!fA.value || e[4] === +fA.value) && (!b || semAcento(e[1] + " " + e[3]).indexOf(b) >= 0); });
        $("#pe-corpo").innerHTML = f.slice(0, limite).map(function (e) {
          return "<tr><td>" + e[4] + '</td><td><a href="politico.html?id=' + encodeURIComponent(e[0]) + '">' + esc(e[1]) + "</a></td><td>" + esc(e[2]) + "</td><td>" + esc(e[3]) + "</td><td>" + esc(e[6]) + '</td><td class="num">' + (e[5] ? num(e[5]) : "—") + "</td></tr>";
        }).join("") || '<tr><td colspan="6" class="muted">Nenhum eleito com esses filtros.</td></tr>';
        $("#pe-mais").hidden = f.length <= limite;
      }
      [fC, fA].forEach(function (el2) { el2.addEventListener("change", function () { limite = 100; render(); }); });
      fB.addEventListener("input", function () { limite = 100; render(); });
      $("#pe-mais").addEventListener("click", function () { limite += 200; render(); });
      // No PDF a lista sai inteira, sem filtros
      window.addEventListener("beforeprint", function () { fC.value = fA.value = fB.value = ""; limite = 1e6; render(); });
      render();
    });
  }

  var paginas = { inicio: paginaInicio, partidos: paginaPartidos, politicos: paginaPoliticos, politico: paginaPolitico, leis: paginaLeis, rankings: paginaRankings, sobre: paginaSobre, gastos: paginaGastos, comparar: paginaComparar, diario: paginaDiario, municipio: paginaMunicipio, tribunais: paginaTribunais, campanhas: paginaCampanhas };
  var atual = document.body.getAttribute("data-page");
  if (paginas[atual]) paginas[atual]();
  atualizacao();
})();
