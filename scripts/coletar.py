"""
Coletor de dados do Almanaque do Poder.

Busca dados públicos em fontes oficiais e grava JSON em data/:
  - SAPL da Câmara Municipal de Manaus (vereadores, normas, autorias)
  - SAPL da Assembleia Legislativa do Amazonas (deputados estaduais)
  - API de Dados Abertos da Câmara dos Deputados (deputados federais do AM)
  - API de Dados Abertos do Senado Federal (senadores do AM)
  - TSE, candidaturas (prefeitos eleitos em 2024 e eleitos em 2026)
  - data/executivo-manual.json (ajustes do Executivo, sempre com fonte)

Só usa a biblioteca padrão do Python. Se uma fonte falhar, mantém o
arquivo anterior daquela fonte em data/fontes/ e segue com as demais.

Uso:  python scripts/coletar.py              (todas as fontes)
      python scripts/coletar.py cmm aleam    (só as fontes indicadas)
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "data"
FONTES = DADOS / "fontes"
CACHE = RAIZ / ".cache"
UA = "AlmanaqueDoPoder/1.0 (NEX - Hub de Analise Estrategica)"
HOJE = date.today().isoformat()


# ---------------------------------------------------------------- utilidades

def log(*a):
    print(*a, file=sys.stderr, flush=True)


def baixar(url: str, timeout: int = 90, tentativas: int = 3) -> bytes:
    erro = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            erro = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"falha ao baixar {url}: {erro}")


def jget(url: str, **kw):
    return json.loads(baixar(url, **kw))


def https(url: str | None) -> str | None:
    if not url:
        return None
    return re.sub(r"^http://", "https://", url)


def sem_acento(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower()


def titulo(s: str) -> str:
    """Converte NOME EM CAIXA ALTA para Nome em Caixa Alta, mantendo preposições."""
    if not s or not s.isupper():
        return s
    minus = {"da", "de", "do", "das", "dos", "e"}
    partes = []
    for i, p in enumerate(s.lower().split()):
        partes.append(p if (i and p in minus) else p[:1].upper() + p[1:])
    return " ".join(partes)


def salvar(nome: str, obj) -> None:
    caminho = DADOS / nome
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def ler(nome: str, padrao=None):
    caminho = DADOS / nome
    if caminho.exists():
        return json.loads(caminho.read_text(encoding="utf-8"))
    return padrao


# ------------------------------------------------- classificação de normas

CATEGORIAS = [
    ("Título honorífico", r"titulo|cidada|cidadao|honorari|benemerit"),
    ("Utilidade pública", r"utilidade publica"),
    ("Honraria", r"medalha|comenda|diploma|mocao de aplauso|ordem do merito|honra ao merito"),
    ("Denominação", r"\bdenomina|da nome|confere o nome|nome de "),
    ("Data comemorativa", r"institui o dia|institui a semana|institui o mes|dia municipal|dia estadual|semana municipal|semana estadual|mes municipal|mes estadual|calendario oficial|data comemorativa|inclui no calendario"),
]
HOMENAGENS = {"Título honorífico", "Utilidade pública", "Honraria", "Denominação", "Data comemorativa"}


def categoria(ementa: str) -> str:
    t = sem_acento(ementa)
    for nome, padrao in CATEGORIAS:
        if re.search(padrao, t):
            return nome
    return "Políticas públicas e outros"


# ----------------------------------------------------------------- SAPL

def sapl_paginas(base: str, caminho: str, params: dict | None = None, workers: int = 4) -> list[dict]:
    params = dict(params or {})
    params["page_size"] = 100
    # Sem ordem fixa a API repete e pula registros entre páginas
    params.setdefault("o", "id")
    url = f"{base}{caminho}?{urllib.parse.urlencode(params)}"
    primeira = jget(url)
    resultados = list(primeira["results"])
    total = primeira["pagination"]["total_pages"]
    if total > 1:
        urls = [f"{url}&page={p}" for p in range(2, total + 1)]
        with ThreadPoolExecutor(workers) as ex:
            for pagina in ex.map(jget, urls):
                resultados.extend(pagina["results"])
    return resultados


def coletar_sapl(casa: str, base: str, cargo: str, esfera: str, municipio: str | None) -> dict:
    log(f"[{casa}] SAPL {base}")
    legis = sapl_paginas(base, "/api/parlamentares/legislatura/")
    atual = next(
        (lg for lg in legis if lg["data_inicio"] <= HOJE <= lg["data_fim"]),
        max(legis, key=lambda x: x["data_inicio"]),
    )
    inicio = atual["data_inicio"]
    ano_inicio = int(inicio[:4])

    mandatos = sapl_paginas(base, "/api/parlamentares/mandato/", {"legislatura": atual["id"]})
    ids_mandato = {m["parlamentar"] for m in mandatos if (m.get("data_fim_mandato") or "9999") >= HOJE}
    parlamentares = [p for p in sapl_paginas(base, "/api/parlamentares/parlamentar/", {"ativo": "True"}) if p["id"] in ids_mandato]

    partidos = {p["id"]: p["sigla"] for p in sapl_paginas(base, "/api/parlamentares/partido/")}
    filiacao = {}
    for f in sorted(sapl_paginas(base, "/api/parlamentares/filiacao/"), key=lambda f: f.get("data") or ""):
        if not f.get("data_desfiliacao"):
            filiacao[f["parlamentar"]] = partidos.get(f["partido"])

    autores = sapl_paginas(base, "/api/base/autor/")
    autor_para_parl = {a["id"]: a["object_id"] for a in autores if a.get("object_id") in ids_mandato}
    nome_autor = {a["id"]: a["nome"] for a in autores}

    # Proposições em que o parlamentar é o primeiro autor, na legislatura atual
    autorias = sapl_paginas(base, "/api/materia/autoria/", {"primeiro_autor": "True"})
    materia_autor: dict[int, int] = {}
    props: dict[int, Counter] = {}
    for a in autorias:
        materia_autor.setdefault(a["materia"], a["autor"])
        pid = autor_para_parl.get(a["autor"])
        if pid is None:
            continue
        m = re.search(r" - (.+?) nº \S+ de (\d{4})", a.get("__str__", ""))
        if not m or int(m.group(2)) < ano_inicio:
            continue
        props.setdefault(pid, Counter())[m.group(1).strip()] += 1

    # Normas publicadas desde o início da legislatura
    tipos = {t["id"]: t["descricao"] for t in sapl_paginas(base, "/api/norma/tiponormajuridica/")}
    normas_raw = []
    for ano in range(ano_inicio, date.today().year + 1):
        normas_raw += sapl_paginas(base, "/api/norma/normajuridica/", {"ano": ano})
    # Nome normalizado -> parlamentar, para ler a autoria escrita na indexação
    por_nome = {sem_acento(p["nome_parlamentar"]): p["id"] for p in parlamentares}

    def autoria_texto(indexacao: str):
        m = re.search(r"Autoria:\s*([^\r\n/]+)", indexacao or "")
        if not m:
            return None, None
        # "Ver. Fulano, Subscrito pelos Vers. ..." -> primeiro autor é Fulano
        texto = re.sub(r"\s+", " ", m.group(1).split(",")[0]).strip()
        limpo = sem_acento(re.sub(r"^(Ver(eador)?a?\.?|Dep(utad[oa])?\.?)\s+", "", texto, flags=re.I)).strip(" .")
        return por_nome.get(limpo), texto

    # A paginação do SAPL pode pular registros. Busca direto pelo projeto
    # a autoria das normas que ficaram sem autor.
    faltando = sorted({n["materia"] for n in normas_raw
                       if n.get("materia") and n["materia"] not in materia_autor and (n.get("data") or "") >= inicio})
    if faltando:
        log(f"[{casa}] buscando autoria de {len(faltando)} projetos")

        def autoria_de(mid):
            try:
                res = jget(f"{base}/api/materia/autoria/?materia={mid}")["results"]
            except Exception:  # noqa: BLE001
                return mid, None
            prim = [a for a in res if a.get("primeiro_autor")] or res
            return mid, (prim[0]["autor"] if prim else None)

        with ThreadPoolExecutor(6) as ex:
            for mid, autor in ex.map(autoria_de, faltando):
                if autor:
                    materia_autor[mid] = autor
        faltam_nomes = {a for a in materia_autor.values() if a not in nome_autor}
        for a in faltam_nomes:
            try:
                nome_autor[a] = jget(f"{base}/api/base/autor/{a}/")["nome"]
            except Exception:  # noqa: BLE001
                pass

    normas = []
    por_parl: dict[int, list] = {}
    for n in normas_raw:
        if (n.get("data") or "") < inicio:
            continue
        # Decretos do Executivo não são produção legislativa
        if "executivo" in sem_acento(tipos.get(n["tipo"], "")):
            continue
        autor = materia_autor.get(n.get("materia"))
        pid = autor_para_parl.get(autor)
        nome_txt = None
        if pid is None:
            pid, nome_txt = autoria_texto(n.get("indexacao"))
        ementa = re.sub(r"\s+", " ", n.get("ementa") or "").strip()
        item = {
            "id": f"{casa}-n{n['id']}",
            "casa": casa,
            "tipo": tipos.get(n["tipo"], ""),
            "numero": n.get("numero"),
            "ano": n.get("ano"),
            "data": n.get("data"),
            "ementa": ementa[:500],
            "categoria": categoria(ementa),
            "autor": f"{casa}-{pid}" if pid else None,
            "autor_nome": titulo(nome_autor.get(autor, "")) if autor else nome_txt,
            "url": f"{base}/norma/{n['id']}",
        }
        normas.append(item)
        if pid:
            por_parl.setdefault(pid, []).append(item)

    politicos = []
    for p in parlamentares:
        minhas = por_parl.get(p["id"], [])
        cats = Counter(x["categoria"] for x in minhas)
        politicos.append({
            "id": f"{casa}-{p['id']}",
            "nome": titulo(p["nome_parlamentar"]),
            "nome_completo": titulo(p.get("nome_completo") or ""),
            "cargo": cargo,
            "casa": casa,
            "esfera": esfera,
            "partido": filiacao.get(p["id"]),
            "uf": "AM",
            "municipio": municipio,
            "foto": https(p.get("fotografia")),
            "email": p.get("email") or None,
            "profissao": p.get("profissao") or None,
            "fonte": f"{base}/parlamentar/{p['id']}",
            "periodo": inicio,
            "metricas": {
                "proposicoes": sum(props.get(p["id"], Counter()).values()),
                "proposicoes_tipo": dict(props.get(p["id"], Counter()).most_common()),
                "normas": len(minhas),
                "homenagens": sum(v for k, v in cats.items() if k in HOMENAGENS),
                "normas_categoria": dict(cats.most_common()),
                "autoria": "primeiro autor",
            },
        })
    log(f"[{casa}] {len(politicos)} parlamentares, {len(normas)} normas")
    return {"politicos": politicos, "normas": normas, "legislatura": {"inicio": inicio, "fim": atual["data_fim"]}}


# ------------------------------------------------------ Câmara dos Deputados

CAMARA = "https://dadosabertos.camara.leg.br/api/v2"


def coletar_camara() -> dict:
    log("[camara] API Câmara dos Deputados")
    inicio = "2023-02-01"
    deps = jget(f"{CAMARA}/deputados?siglaUf=AM&itens=100&ordem=ASC&ordenarPor=nome")["dados"]

    def detalhe(d):
        tipos = Counter()
        for sigla in ("PL", "PLP", "PEC", "PDL"):
            url = f"{CAMARA}/proposicoes?idDeputadoAutor={d['id']}&siglaTipo={sigla}&dataApresentacaoInicio={inicio}&itens=100"
            while url:
                pg = jget(url)
                tipos[sigla] += len(pg["dados"])
                url = next((l["href"] for l in pg["links"] if l["rel"] == "next"), None)
        info = jget(f"{CAMARA}/deputados/{d['id']}")["dados"]
        return {
            "id": f"camara-{d['id']}",
            "nome": d["nome"],
            "nome_completo": titulo(info.get("nomeCivil") or ""),
            "cargo": "Deputado(a) federal",
            "casa": "camara",
            "esfera": "federal",
            "partido": d.get("siglaPartido"),
            "uf": "AM",
            "municipio": None,
            "foto": https(d.get("urlFoto")),
            "email": d.get("email"),
            "profissao": None,
            "fonte": f"https://www.camara.leg.br/deputados/{d['id']}",
            "periodo": inicio,
            "metricas": {
                "proposicoes": sum(tipos.values()),
                "proposicoes_tipo": dict(tipos.most_common()),
                "normas": None,
                "homenagens": None,
                "normas_categoria": {},
                "autoria": "autoria ou coautoria",
            },
        }

    with ThreadPoolExecutor(4) as ex:
        politicos = list(ex.map(detalhe, deps))
    log(f"[camara] {len(politicos)} deputados")
    return {"politicos": politicos, "normas": []}


# ---------------------------------------------------------- Senado Federal

SENADO = "https://legis.senado.leg.br/dadosabertos"


def coletar_senado() -> dict:
    log("[senado] API Senado Federal")
    inicio = "2023-02-01"
    lista = jget(f"{SENADO}/senador/lista/atual.json")["ListaParlamentarEmExercicio"]["Parlamentares"]["Parlamentar"]
    am = [p["IdentificacaoParlamentar"] for p in lista if p["IdentificacaoParlamentar"].get("UfParlamentar") == "AM"]
    politicos, normas = [], []
    for s in am:
        procs = jget(f"{SENADO}/processo.json?codigoParlamentarAutor={s['CodigoParlamentar']}")
        nome = sem_acento(s["NomeParlamentar"])
        tipos, cats = Counter(), Counter()
        for p in procs:
            if (p.get("dataApresentacao") or "") < inicio:
                continue
            primeiro = sem_acento((p.get("autoria") or "").split(",")[0])
            if nome not in primeiro:
                continue
            sigla = (p.get("identificacao") or "").split(" ")[0]
            tipos[sigla] += 1
            situacao = (p.get("situacaoAtual") or "") + " " + (p.get("siglaTipoDeliberacao") or "")
            if "NORMA" in situacao.upper():
                ementa = (p.get("ementa") or "").strip()
                item = {
                    "id": f"senado-n{p['id']}",
                    "casa": "senado",
                    "tipo": p.get("tipoDocumento") or sigla,
                    "numero": p.get("identificacao"),
                    "ano": (p.get("dataApresentacao") or "")[:4],
                    "data": p.get("dataSituacaoAtual") or p.get("dataApresentacao"),
                    "ementa": ementa[:500],
                    "categoria": categoria(ementa),
                    "autor": f"senado-{s['CodigoParlamentar']}",
                    "autor_nome": s["NomeParlamentar"],
                    "url": f"https://www25.senado.leg.br/web/atividade/materias/-/materia/{p.get('codigoMateria')}",
                }
                normas.append(item)
                cats[item["categoria"]] += 1
        politicos.append({
            "id": f"senado-{s['CodigoParlamentar']}",
            "nome": s["NomeParlamentar"],
            "nome_completo": s.get("NomeCompletoParlamentar"),
            "cargo": "Senador(a)",
            "casa": "senado",
            "esfera": "federal",
            "partido": s.get("SiglaPartidoParlamentar"),
            "uf": "AM",
            "municipio": None,
            "foto": https(s.get("UrlFotoParlamentar")),
            "email": s.get("EmailParlamentar"),
            "profissao": None,
            "fonte": https(s.get("UrlPaginaParlamentar")),
            "periodo": inicio,
            "metricas": {
                "proposicoes": sum(tipos.values()),
                "proposicoes_tipo": dict(tipos.most_common()),
                "normas": sum(cats.values()),
                "homenagens": sum(v for k, v in cats.items() if k in HOMENAGENS),
                "normas_categoria": dict(cats.most_common()),
                "autoria": "primeiro autor",
            },
        })
    log(f"[senado] {len(politicos)} senadores, {len(normas)} normas")
    return {"politicos": politicos, "normas": normas}


# ------------------------------------------------------------------- TSE

def tse_am(ano: int) -> list[dict]:
    CACHE.mkdir(exist_ok=True)
    arq = CACHE / f"consulta_cand_{ano}_AM.csv"
    if not arq.exists():
        log(f"[tse] baixando candidaturas {ano}")
        z = zipfile.ZipFile(io.BytesIO(baixar(f"https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_{ano}.zip", timeout=600)))
        nome = next(n for n in z.namelist() if n.endswith("_AM.csv"))
        arq.write_bytes(z.read(nome))
    with arq.open(encoding="latin-1", newline="") as f:
        return list(csv.DictReader(f, delimiter=";"))


def eleito(x: dict) -> bool:
    return x["DS_SIT_TOT_TURNO"].startswith("ELEITO")


def coletar_executivo() -> dict:
    """Prefeitos eleitos em 2024 (TSE) + ajustes manuais com fonte."""
    manual = json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))
    substituidos = {sem_acento(m["municipio"]) for m in manual["titulares"] if m.get("municipio")}
    politicos = []
    for x in tse_am(2024):
        if x["DS_CARGO"] != "PREFEITO" or not eleito(x):
            continue
        if sem_acento(titulo(x["NM_UE"])) in substituidos:
            continue
        politicos.append({
            "id": f"tse-{x['SQ_CANDIDATO']}",
            "nome": titulo(x["NM_URNA_CANDIDATO"]),
            "nome_completo": titulo(x["NM_CANDIDATO"]),
            "cargo": "Prefeito(a)",
            "casa": "prefeituras",
            "esfera": "municipal",
            "partido": x["SG_PARTIDO"],
            "uf": "AM",
            "municipio": titulo(x["NM_UE"]),
            "foto": None,
            "email": None,
            "profissao": titulo(x["DS_OCUPACAO"]) if x["DS_OCUPACAO"] not in ("OUTROS", "#NULO") else None,
            "fonte": "https://dadosabertos.tse.jus.br/dataset/candidatos-2024",
            "periodo": "2025-01-01",
            "nota": "Eleito(a) em 2024 segundo o TSE.",
            "metricas": None,
        })
    for m in manual["titulares"]:
        politicos.append({**m, "metricas": None})
    log(f"[executivo] {len(politicos)} titulares")
    return {"politicos": politicos, "normas": []}


def coletar_eleitos_2026() -> list[dict]:
    cargos = {"GOVERNADOR": 1, "VICE-GOVERNADOR": 2, "SENADOR": 3, "DEPUTADO FEDERAL": 4, "DEPUTADO ESTADUAL": 5}
    saida = []
    for x in tse_am(2026):
        if x["DS_CARGO"] not in cargos or not eleito(x):
            continue
        saida.append({
            "cargo": titulo(x["DS_CARGO"]),
            "ordem": cargos[x["DS_CARGO"]],
            "nome": titulo(x["NM_URNA_CANDIDATO"]),
            "partido": x["SG_PARTIDO"],
            "situacao": titulo(x["DS_SIT_TOT_TURNO"]),
            "turno": x["NR_TURNO"],
        })
    saida.sort(key=lambda e: (e["ordem"], e["nome"]))
    log(f"[tse] {len(saida)} eleitos em 2026")
    return saida


# ------------------------------------------------------------------ main

FONTES_INFO = {
    "cmm": ("Câmara Municipal de Manaus (SAPL)", "https://sapl.cmm.am.gov.br"),
    "aleam": ("Assembleia Legislativa do Amazonas (SAPL)", "https://sapl.al.am.leg.br"),
    "camara": ("Câmara dos Deputados — Dados Abertos", "https://dadosabertos.camara.leg.br"),
    "senado": ("Senado Federal — Dados Abertos", "https://legis.senado.leg.br/dadosabertos"),
    "prefeituras": ("TSE — Candidaturas 2024 e ajustes com fonte", "https://dadosabertos.tse.jus.br"),
}


def main() -> int:
    tarefas = {
        "cmm": lambda: coletar_sapl("cmm", "https://sapl.cmm.am.gov.br", "Vereador(a) de Manaus", "municipal", "Manaus"),
        "aleam": lambda: coletar_sapl("aleam", "https://sapl.al.am.leg.br", "Deputado(a) estadual", "estadual", None),
        "camara": coletar_camara,
        "senado": coletar_senado,
        "prefeituras": coletar_executivo,
    }
    meta_ant = ler("meta.json", {}) or {}
    fontes_meta = {f["id"]: f for f in meta_ant.get("fontes", [])}
    falhas = []
    escolhidas = set(sys.argv[1:]) or set(tarefas)
    for chave, fn in tarefas.items():
        if chave not in escolhidas:
            continue
        try:
            resultado = fn()
            salvar(f"fontes/{chave}.json", resultado)
            nome, url = FONTES_INFO[chave]
            fontes_meta[chave] = {"id": chave, "nome": nome, "url": url, "atualizado_em": HOJE,
                                  "legislatura": resultado.get("legislatura")}
        except Exception as e:  # noqa: BLE001
            falhas.append(chave)
            log(f"[{chave}] FALHOU: {e} — mantendo dados anteriores")

    try:
        if "prefeituras" in escolhidas or not (DADOS / "eleitos-2026.json").exists():
            salvar("eleitos-2026.json", coletar_eleitos_2026())
    except Exception as e:  # noqa: BLE001
        log(f"[tse 2026] FALHOU: {e}")

    # Junta as fontes num único arquivo de políticos e um de normas
    politicos, normas = [], []
    for chave in tarefas:
        dados = ler(f"fontes/{chave}.json")
        if dados:
            politicos += dados["politicos"]
            normas += dados["normas"]
    normas.sort(key=lambda n: n.get("data") or "", reverse=True)
    executivo = json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))
    salvar("politicos.json", politicos)
    salvar("normas.json", normas)
    salvar("meta.json", {
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fontes": list(fontes_meta.values()),
        "ajustes_executivo": executivo.get("fontes", []),
        "falhas": falhas,
        "totais": {"politicos": len(politicos), "normas": len(normas)},
    })
    log(f"OK: {len(politicos)} políticos, {len(normas)} normas. Falhas: {falhas or 'nenhuma'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
