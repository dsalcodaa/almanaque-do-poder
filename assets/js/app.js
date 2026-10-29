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
  function param(nome) {
    return new URLSearchParams(location.search).get(nome);
  }
  function $(sel) { return document.querySelector(sel); }
  function erro(alvo, e) {
    alvo.innerHTML = '<p class="aviso">Não foi possível carregar os dados agora. ' + esc(e.message) + "</p>";
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
  function paginaPoliticos() {
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
  function paginaPolitico() {
    var alvo = $("#perfil"), id = param("id");
    Promise.all([carregar("politicos.json"), carregar("normas.json")]).then(function (r) {
      var p = r[0].find(function (x) { return x.id === id; });
      if (!p) { alvo.innerHTML = '<p class="aviso">Político não encontrado. <a href="politicos.html">Voltar para a lista</a>.</p>'; return; }
      document.title = p.nome + " · Almanaque do Poder";
      var m = p.metricas;
      var normas = r[1].filter(function (n) { return n.autor === p.id; });

      var h = '<section class="hero hero--perfil"><div class="perfil__topo">' + foto(p, "avatar--grande") + "<div>" +
        '<p class="kicker">' + esc(p.cargo) + (p.municipio && p.casa === "prefeituras" ? " · " + esc(p.municipio) : "") + "</p>" +
        '<h1 class="display">' + esc(p.nome) + "</h1>" +
        '<p class="lede">' + esc([p.partido, CASAS[p.casa], p.periodo ? "dados desde " + dataBR(p.periodo) : ""].filter(Boolean).join(" · ")) + "</p>" +
        "</div></div>";
      if (p.nota) h += '<p class="nota">' + esc(p.nota) + "</p>";
      h += "</section>";

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
      var legis = pol.filter(function (p) { return p.metricas; });
      ["cmm", "aleam", "camara", "senado"].forEach(function (c) {
        if (legis.some(function (p) { return p.casa === c; })) fCasa.insertAdjacentHTML("beforeend", '<option value="' + c + '">' + esc(CASAS[c]) + "</option>");
      });
      if (param("casa")) fCasa.value = param("casa");

      var RANKINGS = [
        { titulo: "Mais normas aprovadas", kicker: "Produção", val: function (p) { return p.metricas.normas; }, fmt: num, nota: "Como primeiro autor, na legislatura atual." },
        { titulo: "Mais homenagens aprovadas", kicker: "Homenagens", accent: true, val: function (p) { return p.metricas.homenagens; }, fmt: num, nota: "Títulos, datas comemorativas, denominações, honrarias e utilidade pública." },
        { titulo: "Maior parcela de homenagens", kicker: "Proporção", accent: true, val: function (p) { return p.metricas.normas >= 3 ? pctHomenagem(p) : null; }, fmt: function (v) { return Math.round(v * 100) + "%"; }, nota: "Entre quem aprovou pelo menos 3 normas." },
        { titulo: "Menor parcela de homenagens", kicker: "Proporção", inverso: true, val: function (p) { return p.metricas.normas >= 3 ? pctHomenagem(p) : null; }, fmt: function (v) { return Math.round(v * 100) + "%"; }, nota: "Entre quem aprovou pelo menos 3 normas." },
        { titulo: "Mais proposições apresentadas", kicker: "Atividade", val: function (p) { return p.metricas.proposicoes; }, fmt: num, nota: "Inclui requerimentos e indicações no SAPL. Na Câmara dos Deputados conta PL, PLP, PEC e PDL, com coautoria." }
      ];

      function render() {
        var casa = fCasa.value;
        var base = legis.filter(function (p) { return !casa || p.casa === casa; });
        alvo.innerHTML = RANKINGS.map(function (rk) {
          var itens = base.map(function (p) { return { p: p, v: rk.val(p) }; })
            .filter(function (x) { return x.v != null; })
            .sort(function (a, b) { return rk.inverso ? a.v - b.v : b.v - a.v; })
            .slice(0, 10);
          if (!itens.length) return "";
          var max = Math.max.apply(null, itens.map(function (x) { return x.v; })) || 1;
          return '<section class="section"><p class="kicker">' + esc(rk.kicker) + '</p><h2 class="h2">' + esc(rk.titulo) + '</h2><p class="muted">' + esc(rk.nota) + '</p><ol class="barras barras--rank">' +
            itens.map(function (x, i) {
              return '<li><span class="barras__pos">' + (i + 1) + '</span><a class="barras__rot" href="politico.html?id=' + encodeURIComponent(x.p.id) + '">' + esc(x.p.nome) + ' <span class="muted">' + esc(x.p.partido || "") + (casa ? "" : " · " + esc(CASAS[x.p.casa])) + '</span></a><span class="barras__trilho"><span class="barras__barra' + (rk.accent ? " barras__barra--accent" : "") + '" style="width:' + Math.max((x.v / max) * 100, 1) + '%"></span></span><span class="barras__v">' + rk.fmt(x.v) + "</span></li>";
            }).join("") + "</ol></section>";
        }).join("");
      }
      fCasa.addEventListener("change", render);
      render();
    }).catch(function (e) { erro(alvo, e); });
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

  var paginas = { inicio: paginaInicio, politicos: paginaPoliticos, politico: paginaPolitico, leis: paginaLeis, rankings: paginaRankings, sobre: paginaSobre };
  var atual = document.body.getAttribute("data-page");
  if (paginas[atual]) paginas[atual]();
  atualizacao();
})();
