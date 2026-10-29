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
  function historicoHTML(pe) {
    var cs = pe.candidaturas.slice().sort(function (a, b) { return b.ano - a.ano; });
    var pat = {};
    cs.forEach(function (c) { if (c.patrimonio != null) pat[String(c.ano)] = c.patrimonio; });
    var h = '<section class="section"><p class="kicker">Histórico eleitoral</p><h2 class="h2">Todas as candidaturas no Amazonas</h2>' +
      '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Ano</th><th>Cargo</th><th>Onde</th><th>Partido</th><th class="num">Votos</th><th>Resultado</th><th class="num">Bens declarados</th></tr></thead><tbody>' +
      cs.map(function (c) {
        return "<tr><td>" + c.ano + "</td><td>" + esc(c.cargo) + (c.urna ? '<span class="ledger__sub">' + esc(c.urna) + "</span>" : "") + "</td><td>" +
          (c.ue !== "Amazonas" ? '<a href="municipio.html?m=' + encodeURIComponent(slugJS(c.ue)) + '">' + esc(c.ue) + "</a>" : "Amazonas") + "</td><td>" + esc(c.partido || "—") +
          '</td><td class="num">' + (c.votos != null ? num(c.votos) : "—") + "</td><td>" + (c.eleito ? '<span class="tag tag--accent">' + esc(c.situacao) + "</span>" : esc(c.situacao || "—")) +
          '</td><td class="num">' + (c.patrimonio != null ? reais(c.patrimonio) : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    if (Object.keys(pat).length > 1) h += '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">Patrimônio declarado a cada eleição</h3>' + colunas(pat, reais);
    return h + '<p class="muted">Fonte: TSE, candidaturas, bens e votação nominal (2000 em diante; bens a partir de 2006). "—" indica dado não publicado pelo TSE.</p></section>';
  }
  function doacoesHTML(d) {
    var anos = Object.keys(d || {}).sort().reverse();
    if (!anos.length) return '<section class="section"><p class="kicker">Financiamento de campanha</p><h2 class="h2">Quem pagou as campanhas</h2>' +
      '<p class="prose">Não há prestação de contas no TSE para as campanhas desta pessoa de 2018 em diante. Eleições anteriores a 2018 ainda não foram incluídas, e há candidatos que não declararam receitas.</p></section>';
    return '<section class="section"><p class="kicker">Financiamento de campanha</p><h2 class="h2">Quem pagou as campanhas</h2>' + anos.map(function (a) {
      var x = d[a];
      return '<h3 class="eleitos__cargo" style="margin-top: var(--space-4);">' + a + " · " + esc(x.cargo) + (x.ue && x.ue !== "Amazonas" ? " em " + esc(x.ue) : "") + " · " + esc(x.partido) + "</h3>" +
        '<ul class="pillars"><li class="pillar"><span class="pillar__index pillar__index--valor">' + reais(x.total) + '</span><p class="pillar__text">arrecadados na campanha</p></li>' +
        '<li class="pillar"><span class="pillar__index pillar__index--accent">' + pct(x.publico, x.total) + '</span><p class="pillar__text">dinheiro público (fundo eleitoral e fundo partidário)</p></li>' +
        '<li class="pillar"><span class="pillar__index">' + pct(x.proprio, x.total) + '</span><p class="pillar__text">do próprio bolso do candidato</p></li></ul>' +
        barras(x.origens, reais) +
        '<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Maiores financiadores</th><th>Tipo</th><th class="num">Valor</th></tr></thead><tbody>' +
        x.doadores.map(function (r) { return "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + '</td><td class="num">' + reais(r[2]) + "</td></tr>"; }).join("") + "</tbody></table></div>" +
        (x.estimado ? '<p class="muted">' + reais(x.estimado) + " foram doações estimadas (serviços ou bens cedidos, sem dinheiro).</p>" : "");
    }).join("") + '<p class="muted">Fonte: TSE, prestação de contas final dos candidatos (2018 em diante). Desde 2015, empresas não podem doar para campanhas.</p></section>';
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
      if (idade(pe.nascimento)) cr.push([idade(pe.nascimento) + " anos", "nascimento em " + esc(pe.nascimento)]);
      cr.push([num(cs.length), cs.length === 1 ? "candidatura no Amazonas" : "candidaturas no Amazonas desde " + cs[cs.length - 1].ano]);
      var maisVotos = cs.reduce(function (m, c) { return (c.votos || 0) > (m.votos || 0) ? c : m; }, {});
      if (maisVotos.votos) cr.push([num(maisVotos.votos), "votos, o melhor resultado (" + esc(maisVotos.cargo.toLowerCase()) + ", " + maisVotos.ano + ")"]);
      var ultPat = cs.find(function (c) { return c.patrimonio != null; });
      if (ultPat) cr.push([reais(ultPat.patrimonio), "patrimônio declarado em " + ultPat.ano]);
      if (pe.ocupacao || pe.instrucao) cr.push([esc(pe.ocupacao || "—"), esc(pe.instrucao || "")]);
      h += '<section class="section cracha"><ul class="cracha__lista">' + cr.map(function (c) { return '<li><span class="cracha__n">' + c[0] + '</span><span class="cracha__t">' + c[1] + "</span></li>"; }).join("") + "</ul></section>";
      h += historicoHTML(pe);
      h += '<div id="doacoes"></div>';
      h += '<section class="section"><p class="kicker">Mandato</p><h2 class="h2">Votações, presença e gastos</h2><p class="prose">' +
        (ganhas.length
          ? "Não há registros de votações, presença ou gastos para este nome no site. Esses dados só existem a partir de 2023 e só para quem exerceu mandato na Câmara Municipal de Manaus, na Assembleia Legislativa, na Câmara dos Deputados ou no Senado. Câmaras dos outros municípios não publicam esses dados em formato aberto. Mandatos anteriores a 2023 ainda não foram incluídos."
          : "Sem mandato conquistado nas eleições registradas pelo TSE, por isso não há votações, presença ou gastos de gabinete.") +
        '</p><p><a href="gastos.html">Pesquisar o nome nos gastos de gabinete</a> · <a href="diario.html">Buscar no Diário Oficial</a></p></section>';
      alvo.innerHTML = h;
      carregarDoacoes(id).then(function (d) { var box = $("#doacoes"); if (box) box.outerHTML = doacoesHTML(d); });
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
            if (box && parte[p.pessoa]) box.outerHTML = historicoHTML(parte[p.pessoa]);
          }).catch(function () {});
          carregarDoacoes(p.pessoa).then(function (d) { var box = $("#doacoes"); if (box) box.outerHTML = doacoesHTML(d); });
        }, 0);
      }
      var m = p.metricas;
      var normas = r[1].filter(function (n) { return n.autor === p.id; });

      var h = '<section class="hero hero--perfil"><div class="perfil__topo">' + foto(p, "avatar--grande") + "<div>" +
        '<p class="kicker">' + esc(p.cargo) + (p.municipio && p.casa === "prefeituras" ? " · " + esc(p.municipio) : "") + "</p>" +
        '<h1 class="display">' + esc(p.nome) + "</h1>" +
        '<p class="lede">' + esc([p.partido, CASAS[p.casa], p.periodo ? "dados desde " + dataBR(p.periodo) : ""].filter(Boolean).join(" · ")) + "</p>" +
        "</div></div>";
      if (p.nota) h += '<p class="nota">' + esc(p.nota) + "</p>";
      h += "</section>";

      // Crachá: os números principais do mandato, cada um com fonte oficial
      var cr = [], el = p.eleicao, pr = somaPresenca(p.presenca), tc = totalCota(p);
      if (el && el.votos) cr.push([num(el.votos), "votos na eleição de " + el.ano + " para " + esc(el.cargo.toLowerCase()) + " · " + esc(el.situacao.toLowerCase().replace("por qp", "por quociente partidário"))]);
      if (el && el.patrimonio != null) cr.push([reais(el.patrimonio), "patrimônio declarado ao TSE em " + el.ano]);
      if (el && idade(el.nascimento)) cr.push([idade(el.nascimento) + " anos", [el.instrucao, el.ocupacao].filter(Boolean).map(esc).join(" · ")]);
      if (pr.sessoes) cr.push([pct(pr.presente, pr.sessoes), "presença em sessões (" + num(pr.presente) + " de " + num(pr.sessoes) + ")"]);
      if (pr.sessoes) cr.push([num(pr.sessoes - pr.presente), "faltas em sessões desde " + Object.keys(p.presenca).sort()[0]]);
      if (p.votacoes && p.votacoes.com_orientacao) cr.push([pct(p.votacoes.seguiu_partido, p.votacoes.com_orientacao), "das votações, votou com a maioria do próprio partido"]);
      if (tc != null) cr.push([reais(tc), "de cota parlamentar desde " + Object.keys(p.cota).sort()[0]]);
      if (p.emendas) cr.push([reais(p.emendas.pago), "em emendas pagas desde " + esc(p.emendas.desde)]);
      if (cr.length) {
        h += '<section class="section cracha"><ul class="cracha__lista">' + cr.map(function (c) {
          return '<li><span class="cracha__n">' + c[0] + '</span><span class="cracha__t">' + c[1] + "</span></li>";
        }).join("") + "</ul></section>";
      }

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

      if (p.pessoa) h += '<div id="historico"></div><div id="doacoes"></div>';

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
      h += '<p class="no-print"><button class="button button--ghost" type="button" onclick="window.print()">Exportar PDF</button></p>';
      alvo.innerHTML = h;
    }).catch(function (e) { erro(alvo, e); });
  }

  // ---------- leis e projetos ----------
  function paginaLeis() {
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
    var alvo = $("#rankings"), fCasa = $("#f-casa");
    carregar("politicos.json").then(function (pol) {
      ORDEM_CASAS.forEach(function (c) {
        if (pol.some(function (p) { return p.casa === c; })) fCasa.insertAdjacentHTML("beforeend", '<option value="' + c + '">' + esc(CASAS[c]) + "</option>");
      });
      if (param("casa")) fCasa.value = param("casa");

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

      function linha(x, casa) {
        return '<li><span><a href="politico.html?id=' + encodeURIComponent(x.p.id) + '">' + esc(x.p.nome) + '</a><span class="rk-sub">' +
          esc([x.p.partido, casa ? "" : CASAS[x.p.casa]].filter(Boolean).join(" · ")) + '</span></span><span class="rk-v">' + x.fmt + "</span></li>";
      }
      function render() {
        var casa = fCasa.value;
        if (abas) [].forEach.call(abas.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-g") === grupoAtivo)); });
        var base = pol.filter(function (p) { return !casa || p.casa === casa; });
        alvo.innerHTML = GRUPOS.filter(function (g) { return !grupoAtivo || g === grupoAtivo; }).map(function (g) {
          var cards = RANKINGS.filter(function (rk) { return rk.grupo === g; }).map(function (rk) {
            var itens = base.map(function (p) { return { p: p, v: rk.val(p) }; })
              .filter(function (x) { return x.v != null && !isNaN(x.v); })
              .sort(function (a, b) { return rk.inverso ? a.v - b.v : b.v - a.v; })
              .slice(0, 10)
              .map(function (x) { x.fmt = rk.fmt(x.v); return x; });
            if (!itens.length) return "";
            return '<article class="rk-card' + (rk.accent ? " rk-card--accent" : "") + '"><p class="kicker">' + esc(g) + "</p><h3>" + esc(rk.titulo) + '</h3><p class="muted">' + esc(rk.nota) + "</p>" +
              '<ol class="rk-lista">' + itens.slice(0, 5).map(function (x) { return linha(x, casa); }).join("") + "</ol>" +
              (itens.length > 5 ? '<details><summary>Ver do 6º ao ' + itens.length + 'º</summary><ol class="rk-lista" start="6" style="counter-reset: rk 5">' + itens.slice(5).map(function (x) { return linha(x, casa); }).join("") + "</ol></details>" : "") +
              "</article>";
          }).join("");
          return cards ? '<section class="rk-grupo"><h2 class="h2">' + esc(g) + '</h2><div class="rk-grade">' + cards + "</div></section>" : "";
        }).join("") || '<p class="muted">Nenhum ranking com dados para esse filtro.</p>';
      }
      fCasa.addEventListener("change", render);
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

  var paginas = { inicio: paginaInicio, politicos: paginaPoliticos, politico: paginaPolitico, leis: paginaLeis, rankings: paginaRankings, sobre: paginaSobre, gastos: paginaGastos, comparar: paginaComparar, diario: paginaDiario, municipio: paginaMunicipio, tribunais: paginaTribunais, campanhas: paginaCampanhas };
  var atual = document.body.getAttribute("data-page");
  if (paginas[atual]) paginas[atual]();
  atualizacao();
})();
