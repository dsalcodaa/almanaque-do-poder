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
import html
import io
import json
import re
import shutil
import subprocess
import tempfile
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
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


class Pular(Exception):
    """A fonte não precisa rodar agora (ex.: coleta semestral ainda dentro do prazo)."""


def baixar(url: str, timeout: int = 90, tentativas: int = 3) -> bytes:
    erro = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                dados = r.read()
            if dados[:2] == b"\x1f\x8b":  # alguns servidores (IBGE) respondem compactado mesmo sem pedido
                import gzip
                dados = gzip.decompress(dados)
            return dados
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


# ------------------------------------------------ Portal da Transparência

PORTAL = "https://api.portaldatransparencia.gov.br/api-de-dados"
# Nome do autor como aparece no Portal, quando difere do nome parlamentar
NOME_PORTAL = {"camara-220712": ["FAUSTO SANTOS JR.", "FAUSTO JR."]}


def valor(s: str | None) -> float:
    if not s:
        return 0.0
    return float(s.replace(".", "").replace(",", "."))


def coletar_emendas() -> dict:
    """Emendas parlamentares dos deputados federais e senadores do AM."""
    import os

    chave = os.environ.get("PORTAL_TRANSPARENCIA_KEY")
    if not chave:
        raise RuntimeError("variável PORTAL_TRANSPARENCIA_KEY não definida")
    federais = [p for f in ("camara", "senado") for p in (ler(f"fontes/{f}.json") or {}).get("politicos", [])]
    if not federais:
        raise RuntimeError("rode antes as fontes camara e senado")

    def portal(nome: str, ano: int, pagina: int):
        q = urllib.parse.urlencode({"nomeAutor": nome, "ano": ano, "pagina": pagina})
        req = urllib.request.Request(f"{PORTAL}/emendas?{q}", headers={"chave-api-dados": chave, "Accept": "application/json", "User-Agent": UA})
        for i in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 429:  # limite de requisições por minuto
                    time.sleep(30)
                    continue
                raise
            except Exception:  # noqa: BLE001
                time.sleep(3 * (i + 1))
        raise RuntimeError(f"Portal não respondeu para {nome} {ano}")

    saida = {}
    for p in federais:
        nomes = NOME_PORTAL.get(p["id"]) or [sem_acento(p["nome"]).upper()]
        nome = nomes[0]
        itens, vistos = [], set()
        for nome_busca in nomes:
            for ano in range(2023, date.today().year + 1):
                pagina = 1
                while True:
                    lote = portal(nome_busca, ano, pagina)
                    time.sleep(0.8)  # fica abaixo do limite de 90 requisições por minuto
                    # A busca do Portal é por trecho do nome: confere o nome exato
                    for e in lote:
                        if e.get("nomeAutor") in nomes and e.get("codigoEmenda") not in vistos:
                            vistos.add(e.get("codigoEmenda"))
                            itens.append(e)
                    if len(lote) < 15:
                        break
                    pagina += 1
        por_funcao, por_local, por_ano = Counter(), Counter(), Counter()
        for e in itens:
            pago = valor(e.get("valorPago")) + valor(e.get("valorRestoPago"))
            por_funcao[e.get("funcao") or "Não informada"] += pago
            por_local[e.get("localidadeDoGasto") or "Não informada"] += pago
            por_ano[str(e["ano"])] += pago
        saida[p["id"]] = {
            "autor_portal": nome,
            "quantidade": len(itens),
            "empenhado": round(sum(valor(e.get("valorEmpenhado")) for e in itens), 2),
            "pago": round(sum(valor(e.get("valorPago")) + valor(e.get("valorRestoPago")) for e in itens), 2),
            "por_ano": {k: round(v, 2) for k, v in sorted(por_ano.items())},
            "por_funcao": {k: round(v, 2) for k, v in por_funcao.most_common(10)},
            "por_local": {k: round(v, 2) for k, v in por_local.most_common(10)},
            "desde": "2023",
        }
        log(f"[emendas] {p['nome']}: {len(itens)} emendas")
    return {"emendas": saida}


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


# --------------------------------------------- Cota parlamentar (CEAP)

def resumo_cota(notas: list[dict]) -> dict:
    """Totais por categoria, mês e fornecedor de uma lista de notas."""
    cat, mes, forn = Counter(), Counter(), Counter()
    nome_forn = {}
    for n in notas:
        cat[n["categoria"]] += n["valor"]
        mes[f"{n['ano']}-{int(n['mes']):02d}"] += n["valor"]
        chave = n["cnpj"] or n["fornecedor"]
        forn[chave] += n["valor"]
        nome_forn[chave] = n["fornecedor"]
    return {
        "total": round(sum(n["valor"] for n in notas), 2),
        "notas": len(notas),
        "por_categoria": {k: round(v, 2) for k, v in cat.most_common()},
        "por_mes": {k: round(v, 2) for k, v in sorted(mes.items())},
        "fornecedores": [{"nome": nome_forn[k], "cnpj": k if k != nome_forn[k] else None, "valor": round(v, 2)} for k, v in forn.most_common(8)],
    }


def nome_mascarado(nome: str | None) -> bool:
    return not nome or bool(re.fullmatch(r"[\s*.\-]*", nome)) or nome.count("*") >= 3


def nomear_fornecedores(notas: list[dict], politicos: list[dict]) -> None:
    """Completa fornecedores sem nome (ou mascarados) pela razão social do CNPJ na BrasilAPI (dados da Receita)."""
    cache = ler("fontes/cnpj.json", {}) or {}
    faltam = sorted({n["cnpj"] for n in notas if n.get("cnpj") and nome_mascarado(n.get("fornecedor")) and n["cnpj"] not in cache})
    for cnpj in faltam[:400]:  # limite por coleta, para respeitar a API
        try:
            d = jget(f"https://brasilapi.com.br/api/cnpj/v1/{cnpj}", timeout=30)
            cache[cnpj] = d.get("nome_fantasia") or d.get("razao_social") or None
        except Exception as e:  # noqa: BLE001
            log(f"[cnpj] {cnpj}: {e}")
        time.sleep(0.4)
    if faltam:
        salvar("fontes/cnpj.json", cache)
        log(f"[cnpj] {len(faltam)} CNPJs consultados na BrasilAPI")
    for n in notas:
        if nome_mascarado(n.get("fornecedor")) and cache.get(n.get("cnpj")):
            n["fornecedor"] = cache[n["cnpj"]]
    for p in politicos:
        for ano in (p.get("cota") or {}).values():
            for f in ano.get("fornecedores", []):
                if nome_mascarado(f.get("nome")) and cache.get(f.get("cnpj")):
                    f["nome"] = cache[f["cnpj"]]


def categoria_cota(texto: str) -> str:
    t = sem_acento(texto)
    regras = [
        ("Combustíveis", r"combust|lubrific"),
        ("Locação de veículos", r"loca.*veic|veicul"),
        ("Divulgação", r"divulg|informativ|folder|banner|outdoor|publicidade"),
        ("Consultoria e assessoria", r"consult|assess|pesquisa|trabalhos tecnicos"),
        ("Passagens e fretamento aéreo", r"passag|aere[ao]|aeronave|bilhete"),
        ("Escritório e manutenção", r"escritorio|imovel|aluguel|locacao de imovel|manutencao|material|condominio|energia|agua"),
        ("Telefonia e internet", r"telefon|internet|telecom"),
        ("Alimentação e hospedagem", r"aliment|hosped|refei"),
        ("Segurança", r"seguranca"),
        ("Postais", r"postal|correio"),
    ]
    for nome, padrao in regras:
        if re.search(padrao, t):
            return nome
    return titulo(texto.strip().rstrip(".")) or "Outros"


CMM_AJAX = "https://www.cmm.am.gov.br/wp-admin/admin-ajax.php"


def cmm_ajax(dados: dict):
    corpo = urllib.parse.urlencode(dados).encode()
    for i in range(3):
        try:
            req = urllib.request.Request(CMM_AJAX, data=corpo, headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            erro = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"SIGAE não respondeu: {erro}")


def coletar_ceap_cmm() -> dict:
    """Cota parlamentar dos vereadores de Manaus (SIGAE da CMM), de 2023 em diante."""
    vereadores = (ler("fontes/cmm.json") or {}).get("politicos", [])
    por_nome = {sem_acento(p["nome_completo"]): p["id"] for p in vereadores if p.get("nome_completo")}
    resumo, notas = {}, []
    for ano in range(2023, date.today().year + 1):
        lista = cmm_ajax({"action": "cmm_cotas_ceap_parlamentares", "ano": ano}).get("data") or []
        log(f"[ceap_cmm] {ano}: {len(lista)} gabinetes")

        def busca(p):
            r = cmm_ajax({"action": "cmm_cotas_ceap_fetch", "ano": ano, "modo": "sigae",
                          "mes_inicial": 1, "mes_final": 12, "parlamentar_id": p["id"]})
            return p, (r.get("data") if r.get("success") else None)

        with ThreadPoolExecutor(3) as ex:
            for p, d in ex.map(busca, lista):
                if not d:
                    continue
                pid = por_nome.get(sem_acento(p["nome"]))
                fin = d.get("financeiro") or {}
                minhas = []
                for n in d.get("notas") or []:
                    data = (n.get("data_emissao") or "")[:10]
                    minhas.append({
                        "casa": "cmm",
                        "politico": pid,
                        "politico_nome": titulo(p["nome"]),
                        "ano": ano,
                        "mes": int(data[5:7]) if data else 0,
                        "data": data,
                        "categoria": categoria_cota(n.get("item_despesa") or ""),
                        "fornecedor": next((x.strip() for x in (n.get("nome_fantasia"), n.get("fornecedor"), n.get("razao_social"))
                                            if x and not nome_mascarado(x)), ""),
                        "cnpj": n.get("cnpj") or None,
                        "valor": float(n.get("valor") or 0),
                        "documento": n.get("numero_documento"),
                    })
                notas += minhas
                if pid:
                    r = resumo_cota(minhas)
                    r["cota_disponivel"] = fin.get("total_disponivel")
                    r["cota_mensal"] = fin.get("cota_mensal")
                    r["uso"] = round(r["total"] / fin["total_disponivel"], 4) if fin.get("total_disponivel") else None
                    resumo.setdefault(pid, {})[str(ano)] = r
    log(f"[ceap_cmm] {len(notas)} notas")
    return {"cota": resumo, "notas": notas}


# ------------------------------------------------- Cota parlamentar da ALEAM

ALEAM_CEAP = "https://www.aleam.gov.br/transparencia/controle-de-cota-parlamentar/"
ALEAM_CSV = "https://www.aleam.gov.br/transparencia/wp-content/themes/transparencia/createCeap.php?"
MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
         "Setembro", "Outubro", "Novembro", "Dezembro"]


def aleam_csv(pid: str, ano: int, mes: int) -> str | None:
    """CSV oficial de um gabinete num mês. A ALEAM responde 400 quando não há prestação de contas."""
    q = urllib.parse.urlencode({"parlamentar": pid, "parlamentarJaneiro": pid, "mes": MESES[mes - 1],
                                "ano": ano, "formato": "csv"})
    for i in range(3):
        try:
            req = urllib.request.Request(ALEAM_CSV + q, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8-sig", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            time.sleep(3 * (i + 1))
        except Exception:  # noqa: BLE001
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"ALEAM não respondeu: gabinete {pid}, {mes}/{ano}")


def coletar_ceap_aleam() -> dict:
    """Cota parlamentar (CEAP) dos deputados estaduais, pelo CSV do Portal da Transparência da ALEAM."""
    pagina = baixar(ALEAM_CEAP, timeout=120).decode("utf-8", "replace")
    gabinetes = {}
    for sel in ("dados", "dadosatual"):
        bloco = re.search(r'<select[^>]*id="%s"[^>]*>(.*?)</select>' % sel, pagina, re.S)
        for pid, nome in re.findall(r'<option value="(\d+)"\s*>([^<]+)</option>', bloco.group(1) if bloco else ""):
            gabinetes[pid] = html.unescape(nome).strip()
    if not gabinetes:
        raise RuntimeError("lista de gabinetes da ALEAM não encontrada")

    # Liga o gabinete ao político: primeiro pelo nome parlamentar, depois pelo nome civil do CSV
    politicos = (ler("fontes/aleam.json") or {}).get("politicos", [])
    politicos += [p for p in json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))["titulares"]
                  if p["casa"] == "governo"]
    por_nome = {}
    for p in politicos:
        por_nome[sem_acento(p["nome"]).replace("’", "'")] = p["id"]
        if p.get("nome_completo"):
            por_nome.setdefault(sem_acento(p["nome_completo"]), p["id"])

    hoje = date.today()
    tarefas = [(pid, ano, mes) for pid in gabinetes for ano in range(2023, hoje.year + 1)
               for mes in range(1, 13) if (ano, mes) <= (hoje.year, hoje.month)]
    with ThreadPoolExecutor(4) as ex:
        respostas = list(ex.map(lambda t: (t, aleam_csv(*t)), tarefas))

    notas, credito = [], defaultdict(float)
    for (pid, ano, mes), texto in respostas:
        if not texto or "Lote;" not in texto:
            continue
        cab, _, corpo = texto.partition("Lote;")
        civil = (re.search(r'Deputado\(a\);"?([^"\n]+)', cab) or [None, ""])[1].strip()
        cred = re.search(r'"?Verba Creditada"?;([\d.,]+)', cab)
        politico = por_nome.get(sem_acento(gabinetes[pid]).replace("’", "'")) or por_nome.get(sem_acento(civil))
        if politico and cred:
            credito[(politico, ano)] += valor(cred.group(1))
        for linha in csv.reader(io.StringIO("Lote;" + corpo), delimiter=";"):
            if len(linha) < 9 or linha[0] == "Lote" or not linha[8].strip():
                continue
            benef = linha[3].strip()
            doc, _, nome = benef.partition(" - ") if re.match(r"[\d./*-]+ - ", benef) else ("", "", benef)
            digitos = re.sub(r"\D", "", doc)
            emissao = linha[2].strip()
            iso = f"{emissao[6:10]}-{emissao[3:5]}-{emissao[0:2]}" if re.match(r"\d\d/\d\d/\d{4}", emissao) else ""
            notas.append({
                "casa": "aleam",
                "politico": politico,
                "politico_nome": gabinetes[pid],
                "ano": ano,
                "mes": mes,
                "data": iso,
                "categoria": categoria_cota(linha[4]),
                "fornecedor": nome.strip(),
                "cnpj": digitos if len(digitos) == 14 else None,
                "valor": valor(linha[8].strip()),
                "documento": linha[1].strip() or None,
            })

    resumo = {}
    for pid in {n["politico"] for n in notas if n["politico"]}:
        minhas = [n for n in notas if n["politico"] == pid]
        for ano in sorted({n["ano"] for n in minhas}):
            r = resumo_cota([n for n in minhas if n["ano"] == ano])
            disp = round(credito.get((pid, ano), 0), 2)
            r["cota_disponivel"] = disp or None
            r["uso"] = round(r["total"] / disp, 4) if disp else None
            resumo.setdefault(pid, {})[str(ano)] = r
    log(f"[ceap_aleam] {len(gabinetes)} gabinetes, {len(notas)} notas, {len(resumo)} ligados a políticos")
    return {"cota": resumo, "notas": notas}


# ------------------------------------------------------------ Diário Oficial

DIAS_DIARIO = 60       # janela de edições lidas a cada coleta
DIAS_MENCOES = 365     # menções guardadas
DOE = "https://diario.imprensaoficial.am.gov.br"

TIPOS_ATO = [
    ("Nomeação", r"\bnomea|\bnomear"),
    ("Exoneração", r"exonera"),
    ("Diárias e viagens", r"\bdiaria|viagem"),
    ("Licença", r"licenca"),
    ("Projeto de lei", r"projeto de lei"),
    ("Lei", r"(?<!projeto de )\blei (complementar |ordinaria )?n"),
    ("Requerimento", r"requerimento"),
    ("Indicação", r"\bindicacao"),
    ("Convênio ou emenda", r"convenio|termo de fomento|emenda parlamentar"),
    ("Decreto", r"\bdecreto"),
]


ASSINATURA = re.compile(r"\s*(?:[-–,]\s*)?(?:[a-z]+\s*)?(?:presidente|\d+[ºo°]? ?vice|vice-presidente|prefeit[oa]|secretari[oa]|governador|corregedor|ouvidor|diretor|lider|ordenador)")


def texto_pdf(conteudo: bytes) -> str | None:
    """Extrai o texto de um PDF com pdftotext (poppler ou xpdf); se não houver, tenta pypdf."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(conteudo)
        caminho = f.name
    try:
        if shutil.which("pdftotext"):
            r = subprocess.run(["pdftotext", "-enc", "UTF-8", caminho, "-"], capture_output=True, timeout=300)
            if r.returncode == 0:
                return r.stdout.decode("utf-8", "replace")
        try:
            from pypdf import PdfReader  # opcional
            return "\n".join((p.extract_text() or "") for p in PdfReader(caminho).pages)
        except ImportError:
            return None
    finally:
        Path(caminho).unlink(missing_ok=True)


def edicoes_aleam(desde: date) -> list[dict]:
    saida = []
    for pagina in range(1, 15):
        corpo = baixar(f"https://www.aleam.gov.br/diario/?cpage={pagina}", timeout=120).decode("utf-8", "replace")
        achou = re.findall(r'href="([^"]+\.pdf)"[^>]*>\s*Edição nº\s*(\d+)\s*</a>.*?cont-header-date">\s*(\d\d)/(\d\d)/(\d{4})', corpo, re.S)
        for url, num, d, m, a in achou:
            saida.append({"fonte": "aleam", "nome": "Diário Oficial Eletrônico da ALEAM", "numero": num,
                          "data": f"{a}-{m}-{d}", "url": url})
        if not achou or min(f"{a}-{m}-{d}" for _, _, d, m, a in achou) < desde.isoformat():
            break
    return [e for e in {e["url"]: e for e in saida}.values() if e["data"] >= desde.isoformat()]


def edicoes_cmm(desde: date) -> list[dict]:
    itens = jget(f"https://www.cmm.am.gov.br/wp-json/wp/v2/diario-oficial?per_page=60&after={desde.isoformat()}T00:00:00", timeout=120)
    saida = []
    for it in itens:
        midia = jget(f"https://www.cmm.am.gov.br/wp-json/wp/v2/media?parent={it['id']}", timeout=120)
        pdf = next((m["source_url"] for m in midia if m.get("mime_type") == "application/pdf"), None)
        if pdf:
            saida.append({"fonte": "cmm", "nome": "Diário Oficial Eletrônico da CMM",
                          "numero": html.unescape(it["title"]["rendered"]), "data": it["date"][:10], "url": pdf})
    return saida


def edicoes_doe(desde: date) -> list[dict]:
    saida, dia = [], desde
    while dia <= date.today():
        if dia.weekday() < 5:
            r = jget(f"{DOE}/apifront/portal/edicoes/edicoes_from_data/{dia.isoformat()}.json", timeout=60)
            for it in r.get("itens") or []:
                extra = f" · {it['suplemento_nome']}" if it.get("suplemento_nome") else (" · suplemento" if it.get("suplemento") else "")
                saida.append({"fonte": "doe", "nome": "Diário Oficial do Estado do Amazonas" + extra,
                              "numero": str(it["numero"]), "data": dia.isoformat(),
                              "url": f"{DOE}/portal/edicoes/download/{it['id']}"})
        dia += timedelta(days=1)
    return saida


def padroes_nome(p: dict, fonte: str) -> list[str]:
    """Formas de achar o político no texto, já sem acento e em minúsculas."""
    nome = re.sub(r"\s+", " ", sem_acento(p["nome"]).replace("’", "'")).strip()
    sem_titulo = re.sub(r"^(dra?\.?|delegad[oa]|comandante|cabo|capitao|coronel|pastor[a]?|professor[a]?) ", "", nome)
    cargos = {"aleam": r"deputad[oa]", "camara": r"deputad[oa]", "cmm": r"vereador[a]?", "senado": r"senador[a]?",
              "prefeituras": r"prefeit[oa]", "governo": r"vice-governador[a]?|governador[a]?"}
    pads = [r"\b(?:%s)(?: (?:estadual|federal|municipal))? %s\b" % (cargos.get(p["casa"], "x^"), re.escape(nome))]
    if sem_titulo != nome:
        pads.append(r"\b(?:%s) %s\b" % (cargos.get(p["casa"], "x^"), re.escape(sem_titulo)))
    civil = sem_acento(p.get("nome_completo") or "")
    if len(civil.split()) >= 3:
        pads.append(r"\b%s\b" % re.escape(civil))
    # No diário da própria casa o nome parlamentar sozinho é seguro quando tem duas palavras ou mais,
    # desde que não seja o começo de um nome mais longo (ex.: um servidor homônimo "Felipe Souza dos Santos")
    if fonte == p["casa"] and len(nome.split()) >= 2:
        pads.append(r"\b%s\b(?! (?:d[aeo]s?|e) \w)" % re.escape(nome))
    return pads


def tipo_ato(antes: str, depois: str) -> str:
    """Tipo do ato: a palavra-chave mais próxima antes do nome; se não houver, a primeira logo depois."""
    melhor, pos = None, -1
    for nome, padrao in TIPOS_ATO:
        for m in re.finditer(padrao, antes):
            if m.start() > pos:
                melhor, pos = nome, m.start()
    if melhor:
        return melhor
    for nome, padrao in TIPOS_ATO:
        if re.search(padrao, depois):
            return nome
    return "Menção"


def coletar_diarios() -> dict:
    """Menções aos políticos nos diários oficiais da ALEAM, da CMM e do Estado (DOE-AM)."""
    if not shutil.which("pdftotext"):
        try:
            import pypdf  # noqa: F401
        except ImportError:
            raise RuntimeError("instale o pdftotext (pacote poppler-utils) ou o pypdf para ler os diários")
    ant = ler("fontes/diarios.json") or {}
    lidas = {e["url"]: e for e in ant.get("edicoes", [])}
    hoje = date.today()
    desde = hoje - timedelta(days=DIAS_DIARIO)

    edicoes = []
    for nome, fn in (("aleam", edicoes_aleam), ("cmm", edicoes_cmm), ("doe", edicoes_doe)):
        try:
            e = fn(desde)
            edicoes += e
            log(f"[diarios] {nome}: {len(e)} edições desde {desde}")
        except Exception as erro:  # noqa: BLE001
            log(f"[diarios] {nome} FALHOU: {erro}")

    politicos = []
    for chave in ("cmm", "aleam", "camara", "senado", "prefeituras"):
        politicos += (ler(f"fontes/{chave}.json") or {}).get("politicos", [])
    politicos += json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))["titulares"]
    # Governador e vice assinam quase todo ato do DOE; ali não entram
    alvos = {f: [(p, re.compile("|".join(padroes_nome(p, f)))) for p in politicos
                 if not (f == "doe" and p["casa"] == "governo")] for f in ("aleam", "cmm", "doe")}
    formas = {re.sub(r"\s+", " ", sem_acento(p["nome"]).replace("’", "'")) for p in politicos if len(p["nome"]) > 5}
    formas |= {sem_acento(p["nome_completo"]) for p in politicos if len((p.get("nome_completo") or "").split()) >= 3}
    todos_nomes = re.compile("|".join(sorted(map(re.escape, formas), key=len, reverse=True)))

    mencoes = [m for m in ant.get("mencoes", []) if m["data"] >= (hoje - timedelta(days=DIAS_MENCOES)).isoformat()]
    novas = [e for e in edicoes if e["url"] not in lidas]
    log(f"[diarios] {len(novas)} edições novas para ler")

    def ler_edicao(e):
        try:
            return e, texto_pdf(baixar(e["url"], timeout=300))
        except Exception as erro:  # noqa: BLE001
            log(f"[diarios] {e['url']}: {erro}")
            return e, None

    with ThreadPoolExecutor(3) as ex:
        for e, texto in ex.map(ler_edicao, novas):
            if texto is None:
                continue
            texto = re.sub(r"-\n(?=\w)", "", texto)
            texto = re.sub(r"<#[^>]*>", " ", texto)  # marcadores internos do DOE
            texto = re.sub(r"\s+", " ", texto)
            norm = sem_acento(texto).replace("’", "'")
            if len(norm) != len(texto):
                texto = norm
            achadas = 0
            for p, rx in alvos[e["fonte"]]:
                vistos = 0
                for m in rx.finditer(norm):
                    ini, fim = max(0, m.start() - 260), min(len(norm), m.end() + 260)
                    # Assinatura de ofício (presidente, prefeito, secretário) não é notícia sobre o político
                    if ASSINATURA.match(norm, m.end()) or re.search(r"presidente:? ?$", norm[max(0, m.start() - 40):m.start()]):
                        continue
                    # Listas de nomes (expediente, Mesa, comissões, chamadas) não contam
                    if len(set(todos_nomes.findall(norm[max(0, m.start() - 180):m.end() + 180]))) >= 3:
                        continue
                    trecho = texto[ini:fim].strip()
                    mencoes.append({"politico": p["id"], "politico_nome": p["nome"], "fonte": e["fonte"],
                                    "diario": e["nome"], "edicao": e["numero"], "data": e["data"], "url": e["url"],
                                    "tipo": tipo_ato(norm[max(0, m.start() - 160):m.start()], norm[m.end():m.end() + 60]), "trecho": ("…" if ini else "") + trecho + ("…" if fim < len(norm) else "")})
                    achadas += 1
                    vistos += 1
                    if vistos >= 3:
                        break
            lidas[e["url"]] = {**e, "mencoes": achadas, "lida_em": HOJE}

    janela = {e["url"] for e in edicoes}
    lista = sorted([e for u, e in lidas.items() if u in janela or e["data"] >= desde.isoformat()],
                   key=lambda e: (e["data"], e["fonte"]), reverse=True)
    mencoes.sort(key=lambda m: m["data"], reverse=True)
    log(f"[diarios] {len(lista)} edições na janela, {len(mencoes)} menções guardadas")
    return {"edicoes": lista, "mencoes": mencoes}


def coletar_camara_atividade() -> dict:
    """Cota, presença em sessões e votações dos deputados federais do AM (arquivos da Câmara)."""
    deps = (ler("fontes/camara.json") or {}).get("politicos", [])
    ids = {p["id"].split("-")[1]: p["id"] for p in deps}
    partido = {p["id"]: p.get("partido") for p in deps}
    nomes = {p["id"]: p["nome"] for p in deps}
    arq = "https://dadosabertos.camara.leg.br/arquivos"

    def csv_url(url, zipado=False):
        b = baixar(url, timeout=600)
        if zipado:
            z = zipfile.ZipFile(io.BytesIO(b))
            b = z.read(z.namelist()[0])
        return list(csv.DictReader(io.StringIO(b.decode("utf-8-sig")), delimiter=";"))

    resumo, notas = {}, []
    presenca = {pid: {} for pid in ids.values()}
    votos = {pid: [] for pid in ids.values()}
    for ano in range(2023, date.today().year + 1):
        # Cota parlamentar (CPF não é guardado)
        for r in csv_url(f"https://www.camara.leg.br/cotas/Ano-{ano}.csv.zip", zipado=True):
            pid = ids.get(r.get("ideCadastro"))
            if not pid:
                continue
            valor_n = float((r.get("vlrLiquido") or "0").replace(",", ".") or 0)
            notas.append({
                "casa": "camara", "politico": pid, "politico_nome": nomes[pid], "ano": ano,
                "mes": int(r.get("numMes") or 0), "data": (r.get("datEmissao") or "")[:10],
                "categoria": categoria_cota(r.get("txtDescricao") or ""),
                "fornecedor": (r.get("txtFornecedor") or "").strip(),
                "cnpj": re.sub(r"\D", "", r.get("txtCNPJCPF") or "") or None if len(re.sub(r"\D", "", r.get("txtCNPJCPF") or "")) == 14 else None,
                "valor": valor_n, "documento": r.get("txtNumero"),
            })
        log(f"[camara_atividade] cota {ano}")

        # Presença em sessões deliberativas do Plenário
        sessoes = {e["id"] for e in csv_url(f"{arq}/eventos/csv/eventos-{ano}.csv")
                   if "sessao deliberativa" in sem_acento(e.get("descricaoTipo", "")) and "encerrada" in sem_acento(e.get("situacao", ""))}
        presentes = Counter()
        for e in csv_url(f"{arq}/eventosPresencaDeputados/csv/eventosPresencaDeputados-{ano}.csv"):
            if e["idEvento"] in sessoes and e["idDeputado"] in ids:
                presentes[ids[e["idDeputado"]]] += 1
        for pid in presenca:
            presenca[pid][str(ano)] = {"presente": presentes[pid], "sessoes": len(sessoes)}

        # Votações nominais no Plenário. A orientação oficial vem por bloco com nome
        # truncado ("Bl PlFdrPtUniPp..."), então a referência é a maioria do próprio
        # partido naquela votação, sem contar o voto do deputado.
        plen = {v["id"]: v for v in csv_url(f"{arq}/votacoes/csv/votacoes-{ano}.csv") if v.get("siglaOrgao") == "PLEN"}
        placar = defaultdict(Counter)
        meus = []
        for v in csv_url(f"{arq}/votacoesVotos/csv/votacoesVotos-{ano}.csv"):
            if v["idVotacao"] not in plen:
                continue
            sigla = (v.get("deputado_siglaPartido") or "").upper()
            if v.get("voto") in ("Sim", "Não"):
                placar[(v["idVotacao"], sigla)][v["voto"]] += 1
            pid = ids.get(v.get("deputado_id"))
            if pid:
                meus.append((pid, sigla or (partido[pid] or "").upper(), v))
        for pid, sigla, v in meus:
            info = plen[v["idVotacao"]]
            outros = Counter(placar[(v["idVotacao"], sigla)])
            if v.get("voto") in ("Sim", "Não"):
                outros[v["voto"]] -= 1
            maioria = None
            if outros["Sim"] + outros["Não"] >= 2 and outros["Sim"] != outros["Não"]:
                maioria = "Sim" if outros["Sim"] > outros["Não"] else "Não"
            votos[pid].append({
                "id": v["idVotacao"], "data": (v.get("dataHoraVoto") or info.get("data") or "")[:10],
                "voto": v.get("voto"), "partido": sigla, "maioria_partido": maioria,
                "aprovada": info.get("aprovacao") == "1",
                "descricao": re.sub(r"\s+", " ", info.get("descricao") or "")[:220],
                "proposicao": info.get("ultimaApresentacaoProposicao_descricao") or None,
            })
        log(f"[camara_atividade] presença e votos {ano}")

    for pid in ids.values():
        minhas = [n for n in notas if n["politico"] == pid]
        por_ano = {}
        for ano in sorted({n["ano"] for n in minhas}):
            por_ano[str(ano)] = resumo_cota([n for n in minhas if n["ano"] == ano])
        vs = sorted(votos[pid], key=lambda x: x["data"], reverse=True)
        com_orient = [x for x in vs if x["maioria_partido"] and x["voto"] in ("Sim", "Não")]
        resumo[pid] = {
            "cota": por_ano,
            "presenca": presenca[pid],
            "votos": {
                "total": len(vs),
                "sim": sum(1 for x in vs if x["voto"] == "Sim"),
                "nao": sum(1 for x in vs if x["voto"] == "Não"),
                "com_orientacao": len(com_orient),
                "seguiu_partido": sum(1 for x in com_orient if x["voto"] == x["maioria_partido"]),
                "recentes": vs[:40],
            },
        }
    log(f"[camara_atividade] {len(notas)} notas de cota")
    return {"atividade": resumo, "notas": notas}


def coletar_eleicoes() -> dict:
    """Votos e patrimônio declarado ao TSE, na eleição mais recente de cada político.

    Arquivos grandes (até 600 MB). Rode à mão após cada eleição:
        python scripts/coletar.py eleicoes
    """
    politicos = [p for f in ("cmm", "aleam", "camara", "senado", "prefeituras") for p in (ler(f"fontes/{f}.json") or {}).get("politicos", [])]
    base = "https://cdn.tse.jus.br/estatistica/sead/odsele"

    def arquivo_am(pasta: str, nome: str, ano: int) -> Path:
        CACHE.mkdir(exist_ok=True)
        destino = CACHE / f"{nome}_{ano}_AM.csv"
        if not destino.exists():
            log(f"[eleicoes] baixando {nome} {ano}")
            tmp = CACHE / f"{nome}_{ano}.zip"
            if not tmp.exists():
                req = urllib.request.Request(f"{base}/{pasta}/{nome}_{ano}.zip", headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=1800) as r, tmp.open("wb") as f:
                    while True:
                        bloco = r.read(1 << 20)
                        if not bloco:
                            break
                        f.write(bloco)
            with zipfile.ZipFile(tmp) as z:
                membro = next(n for n in z.namelist() if n.endswith("_AM.csv"))
                destino.write_bytes(z.read(membro))
            tmp.unlink()
        return destino

    def ler_csv(p: Path):
        with p.open(encoding="latin-1", newline="") as f:
            yield from csv.DictReader(f, delimiter=";")

    cargos_por_casa = {
        "cmm": {2024: ["VEREADOR"]},
        "prefeituras": {2024: ["PREFEITO", "VICE-PREFEITO"]},
        "aleam": {2026: ["DEPUTADO ESTADUAL", "DEPUTADO FEDERAL", "SENADOR", "GOVERNADOR", "VICE-GOVERNADOR"], 2022: ["DEPUTADO ESTADUAL"]},
        "camara": {2026: ["DEPUTADO FEDERAL", "SENADOR", "GOVERNADOR", "VICE-GOVERNADOR", "DEPUTADO ESTADUAL"], 2022: ["DEPUTADO FEDERAL"]},
        "senado": {2026: ["SENADOR", "GOVERNADOR", "VICE-GOVERNADOR", "DEPUTADO FEDERAL"], 2022: ["SENADOR"]},
        "governo": {2026: ["GOVERNADOR", "VICE-GOVERNADOR", "SENADOR", "DEPUTADO ESTADUAL", "DEPUTADO FEDERAL"], 2022: ["DEPUTADO ESTADUAL", "GOVERNADOR", "VICE-GOVERNADOR"], 2024: ["PREFEITO", "VICE-PREFEITO", "VEREADOR"]},
    }
    anos = sorted({a for c in cargos_por_casa.values() for a in c}, reverse=True)
    cand, bens, votos = {}, Counter(), Counter()
    for ano in anos:
        cand[ano] = [x for x in tse_am(ano)]
        try:
            for b in ler_csv(arquivo_am("bem_candidato", "bem_candidato", ano)):
                bens[(ano, b["SQ_CANDIDATO"])] += float((b.get("VR_BEM_CANDIDATO") or "0").replace(",", ".") or 0)
        except Exception as e:  # noqa: BLE001
            log(f"[eleicoes] bens {ano}: {e}")
        try:
            for v in ler_csv(arquivo_am("votacao_candidato_munzona", "votacao_candidato_munzona", ano)):
                votos[(ano, v["SQ_CANDIDATO"], v["NR_TURNO"])] += int(v.get("QT_VOTOS_NOMINAIS") or 0)
        except Exception as e:  # noqa: BLE001
            log(f"[eleicoes] votos {ano}: {e}")

    saida = {}
    for p in politicos:
        regras = cargos_por_casa.get(p["casa"], {})
        nomes = {sem_acento(p["nome"]), sem_acento(p.get("nome_completo") or "")} - {""}
        achou = None
        for ano in sorted(regras, reverse=True):
            for x in cand.get(ano, []):
                if x["DS_CARGO"] not in regras[ano]:
                    continue
                if p.get("municipio") and ano == 2024 and sem_acento(x["NM_UE"]) != sem_acento(p["municipio"]):
                    continue
                if sem_acento(x["NM_URNA_CANDIDATO"]) in nomes or sem_acento(x["NM_CANDIDATO"]) in nomes:
                    if x["DS_SITUACAO_CANDIDATURA"] == "INAPTO" and achou:
                        continue
                    achou = (ano, x)
                    if x["DS_SITUACAO_CANDIDATURA"] != "INAPTO":
                        break
            if achou:
                break
        if not achou:
            continue
        ano, x = achou
        turnos = {t: votos[(ano, x["SQ_CANDIDATO"], t)] for t in ("1", "2") if votos[(ano, x["SQ_CANDIDATO"], t)]}
        saida[p["id"]] = {
            "ano": ano,
            "cargo": titulo(x["DS_CARGO"]),
            "partido": x["SG_PARTIDO"],
            "numero": x["NR_CANDIDATO"],
            "situacao": titulo(x["DS_SIT_TOT_TURNO"]),
            "votos": turnos.get("2") or turnos.get("1"),
            "patrimonio": round(bens[(ano, x["SQ_CANDIDATO"])], 2) if (ano, x["SQ_CANDIDATO"]) in bens else None,
            "nascimento": x.get("DT_NASCIMENTO") or None,
            "instrucao": titulo(x.get("DS_GRAU_INSTRUCAO") or "") or None,
            "ocupacao": titulo(x.get("DS_OCUPACAO") or "") or None,
            "fonte": f"https://divulgacandcontas.tse.jus.br/",
        }
    log(f"[eleicoes] {len(saida)} de {len(politicos)} políticos encontrados no TSE")
    return {"eleicoes": saida}


# ------------------------------------------------ Presença no Plenário (SAPL)

def presenca_sapl(casa: str, base: str) -> dict:
    """Presença de cada parlamentar nas sessões ordinárias e extraordinárias, desde 2023.

    A sessão só conta quando a Casa registrou alguma presença nela. O período esperado de cada
    parlamentar é o do mandato, encerrado 45 dias após a última presença registrada (licença,
    afastamento ou cargo no Executivo deixam de contar como falta depois disso)."""
    tipos = {t["id"] for t in sapl_paginas(base, "/api/sessao/tiposessaoplenaria/")
             if re.search(r"ordinaria|extraordinaria", sem_acento(t["nome"]))}
    sessoes = {s["id"]: s["data_inicio"] for s in sapl_paginas(base, "/api/sessao/sessaoplenaria/", {"data_inicio__gte": "2023-01-01"})
               if s.get("tipo") in tipos and s.get("data_inicio")}
    presentes = defaultdict(set)
    for p in sapl_paginas(base, "/api/sessao/sessaoplenariapresenca/", workers=6):
        if p.get("sessao_plenaria") in sessoes:
            presentes[p["parlamentar"]].add(p["sessao_plenaria"])
    com_registro = set().union(*presentes.values()) if presentes else set()
    datas = sorted((sessoes[s], s) for s in com_registro)
    saida = {}
    for m in sapl_paginas(base, "/api/parlamentares/mandato/"):
        pid = m["parlamentar"]
        if not presentes.get(pid) or not m.get("data_inicio_mandato"):
            continue
        ultima = max(sessoes[s] for s in presentes[pid])
        fim = min(m.get("data_fim_mandato") or "9999", (date.fromisoformat(ultima) + timedelta(days=45)).isoformat())
        ano_dados = saida.setdefault(f"{casa}-{pid}", {})
        for d, s in datas:
            if m["data_inicio_mandato"] <= d <= fim:
                a = ano_dados.setdefault(d[:4], {"presente": 0, "sessoes": 0, "_vistas": set()})
                if s in a["_vistas"]:
                    continue
                a["_vistas"].add(s)
                a["sessoes"] += 1
                a["presente"] += s in presentes[pid]
    for anos in saida.values():
        for a in anos.values():
            a.pop("_vistas")
    log(f"[presenca_{casa}] {len(com_registro)} sessões com registro, {len(saida)} parlamentares")
    return saida


def coletar_presenca() -> dict:
    return {"presenca": {**presenca_sapl("cmm", "https://sapl.cmm.am.gov.br"),
                         **presenca_sapl("aleam", "https://sapl.al.am.leg.br")}}


# ------------------------------------------------- Senado: votos, presença e cota

AUSENCIAS_SENADO = {"NCom": "não compareceu", "AP": "atividade parlamentar", "LS": "licença saúde",
                    "LP": "licença particular", "MIS": "missão", "REP": "representação", "LAP": "licença",
                    "LC": "licença", "LG": "licença gestante", "AUS": "ausente"}


def coletar_senado_atividade() -> dict:
    """Votações nominais, presença e cota (CEAPS) dos senadores do AM, desde 2023."""
    senadores = (ler("fontes/senado.json") or {}).get("politicos", [])
    hoje = date.today()
    resumo, notas = {}, []
    for p in senadores:
        cod = int(p["id"].split("-")[1])
        votos, sessoes = [], defaultdict(lambda: {"presente": False, "data": ""})
        for ano in range(2023, hoje.year + 1):
            for ini, fim in ((f"{ano}-01-01", f"{ano}-06-30"), (f"{ano}-07-01", f"{ano}-12-31")):
                if ini > hoje.isoformat():
                    continue
                try:
                    lista = jget(f"{SENADO}/votacao?codigoParlamentar={cod}&dataInicio={ini}&dataFim={fim}", timeout=180)
                except Exception as e:  # noqa: BLE001
                    log(f"[senado_atividade] {p['nome']} {ini}: {e}")
                    continue
                for v in lista:
                    meu = next((x for x in v.get("votos", []) if x.get("codigoParlamentar") == cod), None)
                    if not meu:
                        continue
                    sigla = meu.get("siglaVotoParlamentar") or ""
                    s = sessoes[v["codigoSessao"]]
                    s["data"] = v.get("dataSessao") or ""
                    if sigla not in AUSENCIAS_SENADO:
                        s["presente"] = True
                    else:
                        s.setdefault("motivo", sigla)
                    votos.append({"id": v.get("codigoSessaoVotacao"), "data": v.get("dataSessao"), "voto": sigla,
                                  "descricao": re.sub(r"\s+", " ", v.get("descricaoVotacao") or "")[:220],
                                  "proposicao": v.get("identificacao"), "aprovada": (v.get("resultadoVotacao") or "").upper().startswith("A")})
        pres = {}
        for s in sessoes.values():
            a = pres.setdefault(s["data"][:4], {"presente": 0, "sessoes": 0})
            a["sessoes"] += 1
            a["presente"] += s["presente"]
        ausencias = Counter(AUSENCIAS_SENADO[s["motivo"]] for s in sessoes.values() if not s["presente"] and s.get("motivo"))
        votos.sort(key=lambda x: x["data"] or "", reverse=True)
        resumo[p["id"]] = {
            "presenca": pres,
            "ausencias": dict(ausencias.most_common()),
            "votos": {"total": len(votos), "sim": sum(v["voto"] == "Sim" for v in votos), "nao": sum(v["voto"] == "Não" for v in votos),
                      "com_orientacao": 0, "seguiu_partido": 0, "recentes": [v for v in votos if v["voto"] in ("Sim", "Não", "Abstenção")][:40]},
        }
        log(f"[senado_atividade] {p['nome']}: {len(votos)} votos, {len(sessoes)} sessões")

    por_codigo = {p["id"].split("-", 1)[1]: p for p in senadores}
    for ano in range(2023, hoje.year + 1):
        try:
            linhas = json.loads(baixar(f"https://adm.senado.gov.br/adm-dadosabertos/api/v1/senadores/despesas_ceaps/{ano}", timeout=300))
        except Exception as e:  # noqa: BLE001
            log(f"[senado_atividade] CEAPS {ano}: {e}")
            continue
        for r in linhas:
            p = por_codigo.get(str(r.get("codSenador")))
            if not p:
                continue
            notas.append({
                "casa": "senado", "politico": p["id"], "politico_nome": p["nome"], "ano": ano, "mes": int(r.get("mes") or 0),
                "data": (r.get("data") or "")[:10],
                "categoria": categoria_cota(r.get("tipoDespesa") or ""), "fornecedor": (r.get("fornecedor") or "").strip(),
                "cnpj": (lambda d: d if len(d) == 14 else None)(re.sub(r"\D", "", r.get("cpfCnpj") or "")),
                "valor": float(r.get("valorReembolsado") or 0), "documento": r.get("documento") or None,
            })
    for pid in resumo:
        minhas = [n for n in notas if n["politico"] == pid]
        resumo[pid]["cota"] = {str(a): resumo_cota([n for n in minhas if n["ano"] == a]) for a in sorted({n["ano"] for n in minhas})}
    log(f"[senado_atividade] {len(notas)} notas da CEAPS")
    return {"atividade": resumo, "notas": notas}


# ------------------------------------------------- Histórico eleitoral (TSE)

ANOS_TSE = list(range(2000, date.today().year + 1, 2))


def chave_pessoa(nome: str, nascimento: str) -> str:
    import hashlib
    return "tse-" + hashlib.sha1(f"{sem_acento(nome).upper().strip()}|{nascimento}".encode()).hexdigest()[:10]


_IDS_PESSOA: dict | None = None


def id_pessoa(nome: str, nascimento: str) -> str:
    """Identificador estável da pessoa entre eleições.

    O TSE às vezes grafa o mesmo nome de formas diferentes ("ABDEL AZIZ" e "ABDELAZIZ").
    Nome sem espaços nem pontuação, mais a data de nascimento, aponta para o id da primeira
    candidatura encontrada desde 2000."""
    global _IDS_PESSOA
    if _IDS_PESSOA is None:
        _IDS_PESSOA = {}
        for ano in ANOS_TSE:
            for x in ler_cache_csv(f"consulta_cand_{ano}_AM.csv"):
                n = x.get("DT_NASCIMENTO") or ""
                n = "" if n.startswith("#") else n
                k = (re.sub(r"[^A-Z]", "", sem_acento(x["NM_CANDIDATO"]).upper()), n)
                _IDS_PESSOA.setdefault(k, chave_pessoa(x["NM_CANDIDATO"], n))
    k = (re.sub(r"[^A-Z]", "", sem_acento(nome).upper()), nascimento)
    return _IDS_PESSOA.get(k) or chave_pessoa(nome, nascimento)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", sem_acento(s)).strip("-")


def ler_cache_csv(nome: str):
    caminho = CACHE / nome
    if not caminho.exists():
        return []
    with caminho.open(encoding="latin-1", newline="") as f:
        return list(csv.DictReader(f, delimiter=";"))


def coletar_tse_historico() -> dict:
    """Todas as candidaturas do Amazonas de 2000 em diante: pessoas, histórico, fotos e câmaras por eleição.

    Lê os arquivos do TSE em .cache (consulta_cand, bem_candidato, votacao_candidato_munzona e as fotos
    em .cache/fotos/ANO). Rode à mão: python scripts/coletar.py tse_historico"""
    from PIL import Image

    pessoas, municipios = {}, defaultdict(lambda: {"nome": "", "eleicoes": {}})
    fotos_dir = DADOS / "fotos"
    fotos_dir.mkdir(parents=True, exist_ok=True)
    for ano in ANOS_TSE:
        cand = ler_cache_csv(f"consulta_cand_{ano}_AM.csv")
        if not cand:
            continue
        # O TSE usou grafias antigas de dois municípios em algumas eleições
        for x in cand:
            x["NM_UE"] = NOMES_UE.get(x["NM_UE"], x["NM_UE"])
        bens = Counter()
        for b in ler_cache_csv(f"bem_candidato_{ano}_AM.csv"):
            bens[b["SQ_CANDIDATO"]] += float((b.get("VR_BEM_CANDIDATO") or "0").replace(",", ".") or 0)
        votos = Counter()
        for v in ler_cache_csv(f"votacao_candidato_munzona_{ano}_AM.csv"):
            votos[(v["SQ_CANDIDATO"], v["NR_TURNO"])] += int(v.get("QT_VOTOS_NOMINAIS") or 0)
        fotos = {}
        pasta = CACHE / "fotos" / str(ano)
        if pasta.exists():
            for f in pasta.iterdir():
                m = re.match(r"F?AM(\d+)_div\.", f.name, re.I)
                if m:
                    fotos[m.group(1)] = f
        # Uma linha por candidato (a do último turno disputado)
        por_sq = {}
        for x in cand:
            if x["SQ_CANDIDATO"] not in por_sq or x.get("NR_TURNO", "1") > por_sq[x["SQ_CANDIDATO"]].get("NR_TURNO", "1"):
                por_sq[x["SQ_CANDIDATO"]] = x
        for sq, x in por_sq.items():
            nasc = x.get("DT_NASCIMENTO") or ""
            if nasc.startswith("#"):
                nasc = ""
            pid = id_pessoa(x["NM_CANDIDATO"], nasc)
            v1, v2 = votos.get((sq, "1")), votos.get((sq, "2"))
            situacao = (x.get("DS_SIT_TOT_TURNO") or "").replace("#NULO#", "").strip()
            municipal = x["DS_CARGO"] in ("PREFEITO", "VICE-PREFEITO", "VEREADOR")
            c = {"ano": ano, "cargo": titulo(x["DS_CARGO"]), "ue": titulo(x["NM_UE"]) if municipal else "Amazonas",
                 "partido": x.get("SG_PARTIDO"), "numero": x.get("NR_CANDIDATO"), "urna": titulo(x.get("NM_URNA_CANDIDATO") or ""),
                 "situacao": titulo(situacao) or titulo(x.get("DS_SITUACAO_CANDIDATURA") or ""),
                 "eleito": situacao.startswith("ELEITO"), "votos": v2 or v1, "patrimonio": round(bens[sq], 2) if sq in bens else None}
            pe = pessoas.setdefault(pid, {"id": pid, "nome": titulo(x["NM_CANDIDATO"]), "nascimento": nasc or None,
                                          "candidaturas": [], "foto": None, "_foto_ano": 0})
            pe["candidaturas"].append(c)
            pe["genero"] = titulo(x.get("DS_GENERO") or "") or pe.get("genero")
            pe["instrucao"] = titulo(x.get("DS_GRAU_INSTRUCAO") or "") or pe.get("instrucao")
            pe["ocupacao"] = titulo(x.get("DS_OCUPACAO") or "") or pe.get("ocupacao")
            if sq in fotos and ano >= pe["_foto_ano"]:
                pe["_foto"], pe["_foto_ano"] = fotos[sq], ano
            if municipal:
                m = municipios[slug(x["NM_UE"])]
                m["nome"] = titulo(x["NM_UE"])
                e = m["eleicoes"].setdefault(str(ano), {"prefeito": [], "vice": [], "vereadores": [], "candidatos": 0})
                e["candidatos"] += 1
                if c["eleito"]:
                    alvo = {"PREFEITO": "prefeito", "VICE-PREFEITO": "vice"}.get(x["DS_CARGO"], "vereadores")
                    e[alvo].append({"pessoa": pid, "nome": c["urna"] or pe["nome"], "partido": c["partido"], "votos": c["votos"]})
        log(f"[tse_historico] {ano}: {len(por_sq)} candidaturas, {len(fotos)} fotos")

    # Fotos: a mais recente de cada pessoa, reduzida para 96 x 120 em WebP
    feitas = 0
    for pe in pessoas.values():
        origem = pe.pop("_foto", None)
        pe.pop("_foto_ano", None)
        if not origem:
            continue
        destino = fotos_dir / f"{pe['id']}.webp"
        if not destino.exists():
            try:
                with Image.open(origem) as im:
                    im = im.convert("RGB")
                    im.thumbnail((96, 120))
                    im.save(destino, "WEBP", quality=62, method=6)
                feitas += 1
            except Exception as e:  # noqa: BLE001
                log(f"[tse_historico] foto {origem.name}: {e}")
                continue
        pe["foto"] = f"data/fotos/{pe['id']}.webp"
    log(f"[tse_historico] {len(pessoas)} pessoas, {feitas} fotos novas")

    # Arquivos: índice compacto para a busca e detalhes divididos em 256 partes
    indice = []
    partes = defaultdict(dict)
    for pe in pessoas.values():
        pe["candidaturas"].sort(key=lambda c: c["ano"])
        u = pe["candidaturas"][-1]
        eleicoes_ganhas = sum(c["eleito"] for c in pe["candidaturas"])
        indice.append([pe["id"], u["urna"] or pe["nome"], pe["nome"], u["cargo"], u["ano"], u["ue"], u["partido"], eleicoes_ganhas,
                       1 if pe["foto"] else 0, len(pe["candidaturas"])])
        partes[pe["id"][4:6]][pe["id"]] = pe
    pasta = DADOS / "pessoas"
    pasta.mkdir(exist_ok=True)
    for k, v in partes.items():
        (pasta / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    indice.sort(key=lambda r: (-r[4], r[1]))
    (pasta / "indice.json").write_text(json.dumps(indice, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for m in municipios.values():
        for e in m["eleicoes"].values():
            e["vereadores"].sort(key=lambda v: -(v["votos"] or 0))
    salvar("municipios.json", dict(sorted(municipios.items())))
    return {"pessoas": len(pessoas), "municipios": len(municipios)}


class ArquivoRemoto(io.RawIOBase):
    """Arquivo HTTP lido por partes (Range), para abrir só um CSV dentro de um zip grande do TSE."""

    def __init__(self, url: str):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        self.tamanho = int(urllib.request.urlopen(req, timeout=60).headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, desloc, origem=0):
        self.pos = desloc if origem == 0 else self.pos + desloc if origem == 1 else self.tamanho + desloc
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.tamanho - self.pos
        if n == 0 or self.pos >= self.tamanho:
            return b""
        fim = min(self.pos + n, self.tamanho) - 1
        req = urllib.request.Request(self.url, headers={"User-Agent": UA, "Range": f"bytes={self.pos}-{fim}"})
        dados = urllib.request.urlopen(req, timeout=300).read()
        self.pos += len(dados)
        return dados


def nome_doador(r: dict) -> tuple[str, str]:
    """Nome legível e tipo do doador. Diretórios de partido viram 'PARTIDO (direção estadual)'."""
    origem = (r.get("DS_ORIGEM_RECEITA") or "").replace("Recursos de ", "").replace("Recursos ", "").strip()
    nome = r.get("NM_DOADOR_RFB") or ""
    if nome.startswith("#") or not nome.strip():
        nome = r.get("NM_DOADOR") or ""
    nome = titulo(nome.strip()) if not nome.startswith("#") else "Não informado"
    if "partido" in origem.lower():
        sigla = (r.get("SG_PARTIDO_DOADOR") or "").replace("#NULO#", "").replace("#NULO", "").strip()
        esfera = (r.get("DS_ESFERA_PARTIDARIA_DOADOR") or "").replace("#NULO#", "").replace("#NULO", "").strip().lower()
        nome = (sigla or nome) + (f" (direção {esfera})" if esfera else "")
    origem = origem[:1].upper() + origem[1:]
    return nome, "Recursos próprios" if origem == "Próprios" else origem


NOMES_UE = {"BOA VISTA DE RAMOS": "BOA VISTA DO RAMOS", "NOVO AYRAO": "NOVO AIRÃO"}


def mapa_sq(ano: int) -> tuple[dict, dict]:
    """SQ_CANDIDATO -> (pessoa, nome de urna, local) e (UE, cargo, número) -> SQ, a partir de consulta_cand."""
    por_sq, por_numero = {}, {}
    for x in ler_cache_csv(f"consulta_cand_{ano}_AM.csv"):
        nasc = x.get("DT_NASCIMENTO") or ""
        ue = NOMES_UE.get(x.get("NM_UE") or "", x.get("NM_UE") or "")
        por_sq[x["SQ_CANDIDATO"]] = (id_pessoa(x["NM_CANDIDATO"], "" if nasc.startswith("#") else nasc),
                                     x.get("NM_URNA_CANDIDATO") or x["NM_CANDIDATO"], titulo(ue))
        por_numero[(x.get("SG_UE"), x.get("CD_CARGO"), x.get("NR_CANDIDATO"))] = x["SQ_CANDIDATO"]
    return por_sq, por_numero


def coletar_doacoes() -> dict:
    """Quem financiou as campanhas no Amazonas, de 2018 em diante (prestação de contas do TSE).

    Lê só o arquivo do AM dentro do zip nacional, guarda em .cache e liga cada receita à pessoa do
    histórico (nome + nascimento). CPF e CNPJ de doadores não são publicados no site.
    Rode à mão depois do histórico: python scripts/coletar.py doacoes"""
    base = "https://cdn.tse.jus.br/estatistica/sead/odsele/prestacao_contas"
    por_pessoa: dict = defaultdict(dict)
    doadores: dict = {}
    candidatos = []
    for ano in range(2018, date.today().year + 1, 2):
        nome_csv = f"receitas_candidatos_{ano}_AM.csv"
        cache = CACHE / nome_csv
        if not cache.exists() or ano == date.today().year:
            try:
                z = zipfile.ZipFile(ArquivoRemoto(f"{base}/prestacao_de_contas_eleitorais_candidatos_{ano}.zip"))
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(z.read(nome_csv))
            except Exception as e:  # noqa: BLE001
                log(f"[doacoes] {ano}: {e}")
                if not cache.exists():
                    continue
        cand = mapa_sq(ano)[0]
        campanhas: dict = {}
        for r in ler_cache_csv(nome_csv):
            sq = r.get("SQ_CANDIDATO")
            if sq not in cand:
                continue
            pid, urna, ue = cand[sq]
            v = valor(r.get("VR_RECEITA"))
            if not v:
                continue
            # Erros de digitação no TSE (ex.: vereadores de Anamã em 2020 com R$ 207 milhões cada)
            if v > 30_000_000 or (v > 1_000_000 and (r.get("DS_CARGO") or "").startswith("Vereador")):
                log(f"[doacoes] {ano}: receita ignorada, valor impossível: {r.get('NM_CANDIDATO')} R$ {v:,.0f}")
                continue
            if "aplica" in (r.get("DS_ORIGEM_RECEITA") or "").lower():
                continue  # rendimento de aplicação financeira não é doação
            k = campanhas.setdefault(sq, {"pid": pid, "nome": titulo(urna), "ue": ue, "cargo": titulo(r.get("DS_CARGO") or ""),
                                          "partido": r.get("SG_PARTIDO") or "", "total": 0.0, "estimado": 0.0,
                                          "fontes": Counter(), "origens": Counter(), "doadores": {}})
            k["total"] += v
            if (r.get("DS_NATUREZA_RECEITA") or "").upper().startswith("ESTIM"):
                k["estimado"] += v
            fonte = (r.get("DS_FONTE_RECEITA") or "").upper()
            k["fontes"]["Fundo Eleitoral (público)" if "ESPECIAL" in fonte else "Fundo Partidário (público)" if "PARTID" in fonte else "Outros recursos"] += v
            nome, origem = nome_doador(r)
            k["origens"][origem] += v
            doc = re.sub(r"\D", "", r.get("NR_CPF_CNPJ_DOADOR") or "") or nome
            d = k["doadores"].setdefault(doc, [nome, origem, 0.0])
            d[2] += v
            if "próprios" in origem.lower() or "proprios" in sem_acento(origem):
                continue
            g = doadores.setdefault(doc, {"nome": nome, "tipo": origem, "total": 0.0, "candidatos": {}, "anos": set()})
            g["total"] += v
            g["anos"].add(ano)
            g["candidatos"][pid] = g["candidatos"].get(pid, [urna and titulo(urna), ano, 0.0])
            g["candidatos"][pid][2] += v
        for k in campanhas.values():
            publico = k["fontes"]["Fundo Eleitoral (público)"] + k["fontes"]["Fundo Partidário (público)"]
            proprio = sum(vv for o, vv in k["origens"].items() if "próprios" in o.lower())
            por_pessoa[k["pid"]][str(ano)] = {
                "cargo": k["cargo"], "ue": k["ue"], "partido": k["partido"], "total": round(k["total"], 2),
                "estimado": round(k["estimado"], 2), "publico": round(publico, 2), "proprio": round(proprio, 2),
                "fontes": {a: round(b, 2) for a, b in k["fontes"].most_common()},
                "origens": {a: round(b, 2) for a, b in k["origens"].most_common()},
                "doadores": [[n, o, round(vv, 2)] for n, o, vv in sorted(k["doadores"].values(), key=lambda d: -d[2])[:15]],
            }
            candidatos.append([k["pid"], k["nome"], ano, k["cargo"], k["ue"], k["partido"], round(k["total"], 2), round(publico, 2), round(proprio, 2)])
        nome_desp = f"despesas_contratadas_candidatos_{ano}_AM.csv"
        if not (CACHE / nome_desp).exists() or ano == date.today().year:
            try:
                z = zipfile.ZipFile(ArquivoRemoto(f"{base}/prestacao_de_contas_eleitorais_candidatos_{ano}.zip"))
                (CACHE / nome_desp).write_bytes(z.read(nome_desp))
            except Exception as e:  # noqa: BLE001
                log(f"[doacoes] despesas {ano}: {e}")
        gastos: dict = {}
        for r in ler_cache_csv(nome_desp):
            sq = r.get("SQ_CANDIDATO")
            if sq not in cand:
                continue
            v = valor(r.get("VR_DESPESA_CONTRATADA"))
            if not v or v > 30_000_000 or (v > 1_000_000 and (r.get("DS_CARGO") or "").startswith("Vereador")):
                continue
            g = gastos.setdefault(sq, {"total": 0.0, "tipos": Counter(), "fornecedores": {},
                                       "cargo": titulo(r.get("DS_CARGO") or ""), "partido": r.get("SG_PARTIDO") or ""})
            tipo = (r.get("DS_ORIGEM_DESPESA") or "").strip()
            tipo = "Não especificado" if not tipo or tipo.startswith("#") else tipo
            g["total"] += v
            g["tipos"][tipo] += v
            nome = r.get("NM_FORNECEDOR_RFB") or ""
            if nome.startswith("#") or not nome.strip():
                nome = r.get("NM_FORNECEDOR") or ""
            nome = "Não informado" if nome.startswith("#") or not nome.strip() else titulo(nome.strip())
            doc = re.sub(r"\D", "", r.get("NR_CPF_CNPJ_FORNECEDOR") or "") or nome
            f = g["fornecedores"].setdefault(doc, [nome, tipo, 0.0])
            f[2] += v
        for sq, g in gastos.items():
            pid = cand[sq][0]
            e = por_pessoa[pid].setdefault(str(ano), {"cargo": g["cargo"], "ue": cand[sq][2], "partido": g["partido"],
                                                     "total": 0, "estimado": 0, "publico": 0, "proprio": 0, "fontes": {}, "origens": {}, "doadores": []})
            e["gasto_total"] = round(g["total"], 2)
            e["gastos"] = {a: round(b, 2) for a, b in g["tipos"].most_common()}
            e["fornecedores"] = [[n, t, round(v, 2)] for n, t, v in sorted(g["fornecedores"].values(), key=lambda f: -f[2])[:10]]
        log(f"[doacoes] {ano}: {len(campanhas)} campanhas, {len(gastos)} com despesas")
    partes = defaultdict(dict)
    for pid, anos in por_pessoa.items():
        partes[pid[4:6]][pid] = anos
    pasta = DADOS / "doacoes"
    pasta.mkdir(parents=True, exist_ok=True)
    for p in pasta.glob("*.json"):
        p.unlink()
    for k, v in partes.items():
        salvar(f"doacoes/{k}.json", v)
    lista = sorted(doadores.values(), key=lambda g: -g["total"])[:400]
    salvar("doadores.json", {
        "doadores": [{"nome": g["nome"], "tipo": g["tipo"], "total": round(g["total"], 2), "anos": sorted(g["anos"]),
                      "n": len(g["candidatos"]),
                      "candidatos": [[pid, n, a, round(vv, 2)] for pid, (n, a, vv) in sorted(g["candidatos"].items(), key=lambda i: -i[1][2])[:8]]}
                     for g in lista],
        "candidatos": sorted(candidatos, key=lambda x: -x[6])[:600],
    })
    log(f"[doacoes] {len(por_pessoa)} pessoas, {len(doadores)} doadores")
    return {"pessoas": len(por_pessoa), "doadores": len(doadores)}


def baixar_arquivo(url: str, destino: Path) -> Path:
    """Baixa um arquivo grande direto para o disco."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    tmp = destino.with_suffix(destino.suffix + ".parcial")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=600) as r, tmp.open("wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    tmp.replace(destino)
    return destino


def locais_votacao(ano: int) -> dict:
    """(município, zona, local) -> (município, bairro) dos locais de votação do AM."""
    cache = CACHE / f"locais_votacao_{ano}_AM.csv"
    if not cache.exists():
        url = f"https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_{ano}.zip"
        zp = None
        remoto = zipfile.ZipFile(ArquivoRemoto(url))
        so_am = [n for n in remoto.namelist() if n.upper().endswith("_AM.CSV")]
        if so_am:  # alguns anos vêm divididos por estado: lê só o do AM
            z = remoto
        else:
            zp = baixar_arquivo(url, CACHE / f"eleitorado_local_votacao_{ano}.zip")
            z = zipfile.ZipFile(zp)
        with z, cache.open("w", encoding="utf-8", newline="") as saida:
            nome = so_am[0] if so_am else next(n for n in z.namelist() if n.lower().endswith(".csv"))
            w = csv.writer(saida, delimiter=";")
            w.writerow(["CD_MUNICIPIO", "NR_ZONA", "NR_LOCAL_VOTACAO", "NM_MUNICIPIO", "NM_BAIRRO"])
            vistos = set()
            fonte = io.StringIO(z.read(nome).decode("latin-1")) if so_am else io.TextIOWrapper(z.open(nome), encoding="latin-1")
            for r in csv.DictReader(fonte, delimiter=";"):
                if r.get("SG_UF") != "AM":
                    continue
                k = (r["CD_MUNICIPIO"], r["NR_ZONA"], r["NR_LOCAL_VOTACAO"])
                if k not in vistos:
                    vistos.add(k)
                    w.writerow([*k, r.get("NM_MUNICIPIO", ""), r.get("NM_BAIRRO", "")])
        if zp:
            zp.unlink()
    out = {}
    with cache.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f, delimiter=";"):
            try:
                k = (int(r["CD_MUNICIPIO"]), int(r["NR_ZONA"]), int(r["NR_LOCAL_VOTACAO"]))
            except ValueError:
                continue
            mun = titulo(NOMES_UE.get(r["NM_MUNICIPIO"], r["NM_MUNICIPIO"]))
            bairro = (r.get("NM_BAIRRO") or "").strip()
            out[k] = (mun, titulo(bairro) if bairro and not bairro.startswith("#") else "Bairro não informado")
    return out


def votos_bairro(ano: int, por_sq: dict, por_numero: dict) -> dict:
    """Votos de 1º turno de cada candidato por bairro, cruzando as seções com os locais de votação."""
    locais = locais_votacao(ano)
    zp = CACHE / f"votacao_secao_{ano}_AM.zip"
    if not zp.exists():
        baixar_arquivo(f"https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_{ano}_AM.zip", zp)
    res: dict = defaultdict(Counter)
    with zipfile.ZipFile(zp) as z:
        nome = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        for r in csv.DictReader(io.TextIOWrapper(z.open(nome), encoding="latin-1"), delimiter=";"):
            if r.get("NR_TURNO") != "1":
                continue
            sq = r.get("SQ_CANDIDATO")
            if sq not in por_sq:
                sq = por_numero.get((r.get("SG_UE"), r.get("CD_CARGO"), r.get("NR_VOTAVEL")))
                if not sq:
                    continue
            try:
                k = (int(r["CD_MUNICIPIO"]), int(r["NR_ZONA"]), int(r["NR_LOCAL_VOTACAO"]))
                qt = int(r.get("QT_VOTOS") or 0)
            except (ValueError, KeyError):
                continue
            mun, bairro = locais.get(k, (titulo(r.get("NM_MUNICIPIO") or ""), "Bairro não informado"))
            res[sq][(mun, bairro)] += qt
    return res


def coletar_votos_territorio() -> dict:
    """Onde cada candidato teve votos: por município (desde 2000) e por bairro (desde 2018).

    Usa votacao_candidato_munzona (já em .cache), votacao_secao e os locais de votação do TSE.
    Rode à mão depois do histórico: python scripts/coletar.py votos_territorio"""
    saida: dict = defaultdict(dict)
    for ano in ANOS_TSE:
        por_sq, por_numero = mapa_sq(ano)
        if not por_sq:
            continue
        mun: dict = defaultdict(Counter)
        for v in ler_cache_csv(f"votacao_candidato_munzona_{ano}_AM.csv"):
            if v.get("NR_TURNO") == "1" and v.get("SQ_CANDIDATO") in por_sq:
                nome = titulo(NOMES_UE.get(v.get("NM_MUNICIPIO") or "", v.get("NM_MUNICIPIO") or ""))
                mun[v["SQ_CANDIDATO"]][nome] += int(v.get("QT_VOTOS_NOMINAIS") or 0)
        bairros: dict = {}
        if ano >= 2018:
            try:
                bairros = votos_bairro(ano, por_sq, por_numero)
            except Exception as e:  # noqa: BLE001
                log(f"[votos_territorio] bairros {ano}: {e}")
        for sq, cont in mun.items():
            total = sum(cont.values())
            if not total:
                continue
            e = {"total": total, "municipios": [[k, v] for k, v in cont.most_common(20)]}
            if bairros.get(sq):
                e["bairros"] = [[m, b, v] for (m, b), v in bairros[sq].most_common(25)]
            saida[por_sq[sq][0]][str(ano)] = e
        log(f"[votos_territorio] {ano}: {len(mun)} candidatos, {len(bairros)} com bairros")
    partes: dict = defaultdict(dict)
    for pid, anos in saida.items():
        partes[pid[4:6]][pid] = anos
    pasta = DADOS / "territorio"
    pasta.mkdir(parents=True, exist_ok=True)
    for p in pasta.glob("*.json"):
        p.unlink()
    for k, v in partes.items():
        salvar(f"territorio/{k}.json", v)
    return {"pessoas": len(saida)}


# Grafias diferentes da mesma sigla
SIGLA_ALIAS = {"REP": "REPUBLICANOS", "PROGRESSISTAS": "PP", "PCDOB": "PC do B", "SD": "SOLIDARIEDADE",
               "UNIÃO BRASIL": "UNIÃO", "PODEMOS": "PODE", "PATRI": "PATRIOTA"}
# Mudanças de nome e incorporações registradas no TSE (sigla antiga: sucessora)
SIGLA_SUCESSORA = {
    "PMDB": "MDB", "PFL": "DEM", "DEM": "UNIÃO", "PSL": "UNIÃO", "PRONA": "PR", "PR": "PL", "PST": "PL", "PGT": "PL",
    "PRB": "REPUBLICANOS", "PPS": "CIDADANIA", "PTN": "PODE", "PHS": "PODE", "PSC": "PODE", "PT do B": "AVANTE",
    "PSDC": "DC", "PRN": "PTC", "PTC": "AGIR", "PMN": "MOBILIZA", "PEN": "PATRIOTA", "PRP": "PATRIOTA",
    "PAN": "PTB", "PATRIOTA": "PRD", "PTB": "PRD", "PROS": "SOLIDARIEDADE", "PPL": "PC do B", "PPB": "PP",
}


def sigla_atual(s: str | None) -> str:
    s = SIGLA_ALIAS.get(s or "", s or "")
    while s in SIGLA_SUCESSORA:
        s = SIGLA_SUCESSORA[s]
    return s


def montar_partidos() -> None:
    """Junta o histórico do TSE e as campanhas por partido, agrupando siglas antigas na sucessora atual.

    Gera data/partidos.json (resumo de todos) e data/partidos/{slug}.json (eleitos de cada um)."""
    pasta = DADOS / "pessoas"
    if not (pasta / "indice.json").exists():
        return
    res = defaultdict(lambda: {"siglas": Counter(), "candidaturas": 0, "eleitos": 0, "por_ano": {}, "por_cargo": {}, "campanha": {}})
    eleitos = defaultdict(list)
    for arq in sorted(pasta.glob("??.json")):
        for pid, pe in json.loads(arq.read_text(encoding="utf-8")).items():
            for c in pe["candidaturas"]:
                if not c.get("partido") or "SUPLENTE" in c["cargo"].upper():
                    continue
                sig = SIGLA_ALIAS.get(c["partido"], c["partido"])
                s = sigla_atual(sig)
                r = res[s]
                r["siglas"][sig] += 1
                r["candidaturas"] += 1
                a = r["por_ano"].setdefault(str(c["ano"]), [0, 0, 0, []])  # candidaturas, eleitos, votos, siglas usadas
                a[0] += 1
                a[2] += c.get("votos") or 0
                if sig not in a[3]:
                    a[3].append(sig)
                pc = r["por_cargo"].setdefault(c["cargo"], [0, 0])
                pc[0] += 1
                if c.get("eleito"):
                    r["eleitos"] += 1
                    a[1] += 1
                    pc[1] += 1
                    eleitos[s].append([pid, c.get("urna") or pe["nome"], c["cargo"], c["ue"], c["ano"], c.get("votos"), sig])
    pasta_doa = DADOS / "doacoes"
    for arq in sorted(pasta_doa.glob("??.json")) if pasta_doa.exists() else []:
        for anos in json.loads(arq.read_text(encoding="utf-8")).values():
            for ano, x in anos.items():
                if not x.get("partido"):
                    continue
                cp = res[sigla_atual(x["partido"])]["campanha"].setdefault(ano, [0, 0, 0, 0])  # arrecadado, público, gasto, campanhas
                cp[0] += x.get("total") or 0
                cp[1] += x.get("publico") or 0
                cp[2] += x.get("gasto_total") or 0
                cp[3] += 1
    destino = DADOS / "partidos"
    destino.mkdir(exist_ok=True)
    for p in destino.glob("*.json"):
        p.unlink()
    # Vereadores fora de Manaus eleitos na última eleição municipal: mandato vigente sem cadastro próprio no site
    ano_mun = max((e[4] for es in eleitos.values() for e in es if e[2] == "Vereador"), default=0)
    saida = {}
    for s, r in res.items():
        r["vereadores_interior"] = sum(1 for e in eleitos[s] if e[4] == ano_mun and e[2] == "Vereador" and e[3] != "Manaus")
        r["siglas"] = [k for k, _ in r["siglas"].most_common()]
        r["slug"] = slug(s)
        for v in r["campanha"].values():
            v[:3] = [round(x, 2) for x in v[:3]]
        saida[s] = r
        salvar(f"partidos/{r['slug']}.json", sorted(eleitos[s], key=lambda e: (-e[4], e[2], -(e[5] or 0))))
    salvar("partidos.json", {"ano_municipal": ano_mun, "alias": SIGLA_ALIAS, "sucessora": SIGLA_SUCESSORA, "partidos": saida})
    log(f"[partidos] {len(saida)} partidos")


def ligar_pessoas(politicos: list[dict]) -> None:
    """Liga cada político em exercício à sua pessoa no histórico do TSE (nome civil + nascimento, ou nome de urna)."""
    pasta = DADOS / "pessoas"
    if not (pasta / "indice.json").exists():
        return
    indice = json.loads((pasta / "indice.json").read_text(encoding="utf-8"))
    por_civil, por_urna = defaultdict(list), defaultdict(list)
    for r in indice:
        por_civil[sem_acento(r[2])].append(r)
        por_urna[sem_acento(r[1])].append(r)
    cache_partes = {}
    for p in politicos:
        el = p.get("eleicao") or {}
        candidatos = por_civil.get(sem_acento(p.get("nome_completo") or ""), []) or por_urna.get(sem_acento(p["nome"]), [])
        if len(candidatos) > 1 and el.get("nascimento"):
            filtro = []
            for r in candidatos:
                parte = cache_partes.setdefault(r[0][4:6], json.loads((pasta / f"{r[0][4:6]}.json").read_text(encoding="utf-8")))
                if parte[r[0]].get("nascimento") == el["nascimento"]:
                    filtro.append(r)
            candidatos = filtro or candidatos
        if len(candidatos) == 1 or (candidatos and p.get("municipio")):
            r = candidatos[0]
            if p.get("municipio"):
                r = next((c for c in candidatos if sem_acento(c[5]) == sem_acento(p["municipio"])), candidatos[0])
            p["pessoa"] = r[0]
            if not p.get("foto") and r[8]:
                p["foto"] = f"data/fotos/{r[0]}.webp"


# ------------------------------------------------------------- Tribunais

TRIBUNAIS = {
    "tjam": "Tribunal de Justiça do Amazonas",
    "mpam": "Ministério Público do Amazonas",
    "trt11": "Tribunal Regional do Trabalho da 11ª Região",
    "tream": "Tribunal Regional Eleitoral do Amazonas",
}


def coletar_tribunais() -> dict:
    """Membros e remuneração mensal (últimos 12 meses publicados) de TJAM, MPAM, TRT11 e TRE-AM, pelo DadosJusBr,
    e do TCE-AM, pelos contracheques em PDF do portal do tribunal.

    Roda a cada seis meses na atualização diária. Para forçar: python scripts/coletar.py tribunais"""
    hoje = date.today()
    anterior = ler("fontes/tribunais.json") or {}
    if "tribunais" not in sys.argv[1:] and anterior.get("coletado_em"):
        dias = (hoje - date.fromisoformat(anterior["coletado_em"])).days
        if dias < 182:
            raise Pular(f"coleta semestral; a última foi há {dias} dias")
    saida = {}
    for org, nome in TRIBUNAIS.items():
        membros, meses = {}, []
        a, m = hoje.year, hoje.month
        tentativas = 0
        while len(meses) < 12 and tentativas < 20:
            tentativas += 1
            m -= 1
            if m == 0:
                a, m = a - 1, 12
            try:
                info = jget(f"https://api.dadosjusbr.org/v2/dados/{org}/{a}/{m}", timeout=60)
                url = (info.get("pacote_de_dados") or {}).get("url")
                if not url:
                    continue
                z = zipfile.ZipFile(io.BytesIO(baixar(url, timeout=180)))
            except Exception:  # noqa: BLE001
                continue
            meses.append(f"{a}-{m:02d}")
            cc = list(csv.DictReader(io.StringIO(z.read("contracheque.csv").decode("utf-8")), delimiter=";"))
            rub = defaultdict(Counter)
            for r in csv.DictReader(io.StringIO(z.read("remuneracao.csv").decode("utf-8")), delimiter=";"):
                if r.get("tipo") != "D":
                    rub[r["id_contracheque"]][r["item"].strip()] += valor(r["valor"])
            for r in cc:
                chave = sem_acento(r["nome"]).upper()
                x = membros.setdefault(chave, {"nome": titulo(r["nome"]), "cargo": titulo(r.get("funcao") or ""), "lotacao": titulo(r.get("local_trabalho") or ""),
                                               "meses": 0, "bruto": 0.0, "liquido": 0.0, "diarias": 0.0, "maior_mes": 0.0, "maior_mes_ref": None,
                                               "rubricas": Counter()})
                bruto = valor(r.get("salario")) + valor(r.get("beneficios"))
                x["meses"] += 1
                x["bruto"] += bruto
                x["liquido"] += valor(r.get("remuneracao"))
                if bruto > x["maior_mes"]:
                    x["maior_mes"], x["maior_mes_ref"] = bruto, f"{a}-{m:02d}"
                for item, v in rub[r["id_contracheque"]].items():
                    x["rubricas"][item] += v
                    if "diaria" in sem_acento(item):
                        x["diarias"] += v
        lista = []
        for x in membros.values():
            x["rubricas"] = {k: round(v, 2) for k, v in x["rubricas"].most_common(6)}
            for k in ("bruto", "liquido", "diarias", "maior_mes"):
                x[k] = round(x[k], 2)
            x["media_bruta"] = round(x["bruto"] / x["meses"], 2) if x["meses"] else None
            lista.append(x)
        lista.sort(key=lambda x: -x["bruto"])
        saida[org] = {"nome": nome, "meses": sorted(meses), "membros": lista,
                      "fonte": f"https://dadosjusbr.org/orgao/{org}"}
        log(f"[tribunais] {org}: {len(lista)} membros, {len(meses)} meses")
    try:
        saida["tceam"] = coletar_tceam()
    except Exception as e:  # noqa: BLE001
        log(f"[tribunais] tceam: {e}")
        if (anterior.get("tribunais") or {}).get("tceam"):
            saida["tceam"] = anterior["tribunais"]["tceam"]
    return {"tribunais": saida, "coletado_em": hoje.isoformat()}


TCE_PORTAL = "https://transparencia-new.tceam.tc.br/contracheque_membros"
TCE_ACAO = "00d2f16bb04eea19db5b26e11259bb6dcecde22201"  # server action do Next.js que lista as pastas
MESES_NOME = {n: i + 1 for i, n in enumerate(["JANEIRO", "FEVEREIRO", "MARCO", "ABRIL", "MAIO", "JUNHO", "JULHO",
                                                "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"])}


def arvore_tceam() -> list:
    """Lista de pastas e arquivos de contracheques do portal do TCE-AM.

    O portal é um app Next.js: a lista vem de uma server action. Se o identificador mudar
    depois de uma atualização do portal, procura o novo nos scripts da página."""
    def chamar(acao):
        req = urllib.request.Request(TCE_PORTAL, data=b"[]", headers={
            "User-Agent": UA, "Accept": "text/x-component", "Content-Type": "text/plain;charset=UTF-8", "Next-Action": acao})
        texto = urllib.request.urlopen(req, timeout=90).read().decode("utf-8")
        for linha in texto.splitlines():
            if linha.startswith("1:"):
                return json.loads(linha[2:]).get("data") or []
        return []

    try:
        dados = chamar(TCE_ACAO)
        if dados:
            return dados
    except Exception:  # noqa: BLE001
        pass
    pagina = baixar(TCE_PORTAL).decode("utf-8", "replace")
    for js in dict.fromkeys(re.findall(r'src="(/_next/static/chunks/[^"]+\\.js)"', pagina)):
        corpo = baixar("https://transparencia-new.tceam.tc.br" + js).decode("utf-8", "replace")
        for acao in dict.fromkeys(re.findall(r'"([0-9a-f]{40,42})"', corpo)):
            try:
                dados = chamar(acao)
            except Exception:  # noqa: BLE001
                continue
            if dados:
                return dados
    raise RuntimeError("não achei a lista de contracheques no portal do TCE-AM")


def ler_contracheque_tce(pdf: bytes) -> dict | None:
    """Nome, cargo, totais e rubricas de um contracheque do TCE-AM (modelo único nacional)."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf)
        caminho = f.name
    try:
        if shutil.which("pdftotext"):
            corrido = subprocess.run(["pdftotext", "-enc", "UTF-8", caminho, "-"], capture_output=True, timeout=120).stdout.decode("utf-8", "replace")
            layout = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", caminho, "-"], capture_output=True, timeout=120).stdout.decode("utf-8", "replace")
        else:
            corrido = layout = texto_pdf(pdf) or ""
    finally:
        Path(caminho).unlink(missing_ok=True)

    def achar(rotulo):
        m = re.search(rotulo + r":\s*R\$\s*([\d.]+,\d\d)", corrido)
        return valor(m.group(1)) if m else None

    bruto = achar("Total Bruto")
    if bruto is None:
        return None
    nome = re.search(r"Nome do\(a\) Membro:\s*(.+?)(?:\s+Matr[ií]cula|\n)", corrido)
    cargo = re.search(r"Cargo:\s*(.+)", corrido)
    rubricas = Counter()
    for linha in layout.splitlines():
        m = re.match(r"\s*TRU-(\d+)\s+(.+?)\s{2,}([\d.]+,\d\d)\s*$", linha)
        if m and m.group(1)[0] != "9" and valor(m.group(3)):
            rubricas[m.group(2).strip()] += valor(m.group(3))
    return {"nome": titulo(nome.group(1).strip()) if nome else "", "cargo_pdf": titulo(cargo.group(1).strip()) if cargo else "",
            "bruto": bruto, "descontos": achar("Descontos") or 0.0, "liquido": achar("Total L[ií]quido") or 0.0,
            "rubricas": dict(rubricas)}


def coletar_tceam() -> dict:
    """Contracheques de conselheiros, conselheiros substitutos e procuradores de contas do TCE-AM.

    Cada PDF lido fica guardado em data/fontes/tce_contracheques.json, então só os meses novos são baixados."""
    cache = ler("fontes/tce_contracheques.json") or {}
    cargos = {"CONSELHEIRO": "Conselheiro", "CONSELHEIRO SUBSTITUTO": "Conselheiro substituto", "PROCURADOR": "Procurador de contas"}
    arquivos = []

    def andar(nos, caminho):
        for n in nos:
            if n.get("tipo") == "pasta":
                andar(n.get("filhos") or [], caminho + [n["nome"]])
            elif n.get("tipo") == "arquivo" and n.get("link"):
                arquivos.append((caminho, n))

    andar(arvore_tceam(), [])
    novos = 0
    for caminho, n in arquivos:
        idm = re.search(r"/d/([\w-]+)", n["link"])
        if not idm or len(caminho) < 2 or not caminho[0].isdigit():
            continue
        mes = MESES_NOME.get(sem_acento(caminho[1]).upper())
        if not mes:
            continue
        chave = idm.group(1)
        if chave not in cache:
            try:
                pdf = baixar(f"https://drive.google.com/uc?export=download&id={chave}", timeout=120)
                dado = ler_contracheque_tce(pdf) if pdf[:4] == b"%PDF" else None
            except Exception as e:  # noqa: BLE001
                log(f"[tribunais] tceam: {n['nome']}: {e}")
                continue
            if not dado:
                continue
            cache[chave] = dado
            novos += 1
        cache[chave]["ref"] = f"{caminho[0]}-{mes:02d}"
        cache[chave]["cargo"] = cargos.get(caminho[2].upper(), "") if len(caminho) > 2 else ""
    salvar("fontes/tce_contracheques.json", cache)

    membros, meses = {}, set()
    for d in cache.values():
        if not d.get("ref") or not d.get("nome"):
            continue
        meses.add(d["ref"])
        x = membros.setdefault(sem_acento(d["nome"]).upper(), {
            "nome": d["nome"], "cargo": d.get("cargo") or d.get("cargo_pdf") or "", "lotacao": d.get("cargo_pdf") or "",
            "meses": 0, "bruto": 0.0, "liquido": 0.0, "diarias": 0.0, "maior_mes": 0.0, "maior_mes_ref": None, "rubricas": Counter()})
        x["meses"] += 1
        x["bruto"] += d["bruto"]
        x["liquido"] += d["liquido"]
        if d["bruto"] > x["maior_mes"]:
            x["maior_mes"], x["maior_mes_ref"] = d["bruto"], d["ref"]
        for k, v in d["rubricas"].items():
            x["rubricas"][k] += v
            if "diaria" in sem_acento(k):
                x["diarias"] += v
    lista = []
    for x in membros.values():
        x["rubricas"] = {k: round(v, 2) for k, v in x["rubricas"].most_common(6)}
        for k in ("bruto", "liquido", "diarias", "maior_mes"):
            x[k] = round(x[k], 2)
        x["media_bruta"] = round(x["bruto"] / x["meses"], 2)
        lista.append(x)
    lista.sort(key=lambda x: -x["bruto"])
    log(f"[tribunais] tceam: {len(lista)} membros, {len(meses)} meses ({novos} contracheques novos)")
    return {"nome": "Tribunal de Contas do Estado do Amazonas", "meses": sorted(meses), "membros": lista, "fonte": TCE_PORTAL,
            "nota": "O TCE-AM publica um contracheque em PDF por membro e por mês; o site lê cada arquivo. Inclui os procuradores do Ministério Público de Contas."}


# ------------------------------------------------- acervo de leis do Amazonas

ACERVO_SAPL = {
    "estado": "https://sapl.al.am.leg.br",
    "manaus": "https://sapl.cmm.am.gov.br",
    "coari": "https://sapl.coari.am.leg.br",
    "codajas": "https://sapl.codajas.am.leg.br",
    "envira": "https://sapl.envira.am.leg.br",
    "iranduba": "https://sapl.iranduba.am.leg.br",
    "manacapuru": "https://sapl.manacapuru.am.leg.br",
    "manicore": "https://sapl.manicore.am.leg.br",
    "novo-airao": "https://sapl.novoairao.am.leg.br",
    "parintins": "https://sapl.parintins.am.leg.br",
    "tefe": "https://sapl.tefe.am.leg.br",
}
AAM = "https://www.diariomunicipal.com.br/aam"
UA_AAM = {"User-Agent": "AlmanaqueDoPoder/1.0 (acervo de leis do Amazonas; consulta pausada)"}


def tipo_lei(texto: str) -> str | None:
    """Tipo canônico da norma, ou None se não for lei (projeto, decreto, resolução, veto...)."""
    t = sem_acento(texto).upper().strip()
    if re.match(r"\W*(PROJETO|MENSAGEM|VETO|AUTOGRAFO|ERRATA|AVISO|EXTRATO|DECRETO|RESOLU|PORTARIA|REGIMENTO|ATO\b|INDICA|REQUERIMENTO)", t):
        return None
    for rx, nome in ((r"EMENDA\s+(A\s+)?(LEI\s+)?ORGANICA", "Emenda à Lei Orgânica"), (r"EMENDA\s+CONSTITUCIONAL|EMENDA\s+A\s+CONSTITUICAO", "Emenda Constitucional"),
                     (r"CONSTITUICAO", "Constituição"), (r"LEI\s+ORGANICA", "Lei Orgânica"), (r"LEI\s+COMPLEMENTAR", "Lei Complementar"),
                     (r"LEI\s+PROMULGADA", "Lei Promulgada"), (r"LEI\s+DELEGADA", "Lei Delegada"), (r"LEI\b", "Lei Ordinária")):
        if re.match(r"\W*" + rx, t):
            return nome
    return None


def acervo_sapl(base: str) -> list[list]:
    tipos = {t["id"]: t.get("descricao") or t.get("sigla") or "" for t in sapl_paginas(base, "/api/norma/tiponormajuridica/")}
    linhas = []
    for n in sapl_paginas(base, "/api/norma/normajuridica/"):
        tipo = tipo_lei(tipos.get(n.get("tipo"), ""))
        if not tipo:
            continue
        ano = n.get("ano")
        data = n.get("data") or ""
        if ano and data[:4] != str(ano):  # algumas câmaras cadastraram a data errada; vale o ano da lei
            data = ""
        ementa = re.sub(r"\s+", " ", n.get("ementa") or "").strip()
        linhas.append([tipo, str(n.get("numero") or "").lstrip("0") or "s/n", ano, data, ementa, categoria(ementa) if ementa else "",
                       f"{base}/norma/{n['id']}", "SAPL"])
    return linhas


def aam_get(url: str) -> str:
    time.sleep(0.8)  # o diário é de uma associação de municípios: uma requisição por vez, com pausa
    req = urllib.request.Request(url, headers=UA_AAM)
    for i in range(3):
        try:
            return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            if i == 2:
                raise
            time.sleep(10 * (i + 1))
    return ""


def ementa_aam(pagina: str, titulo: str) -> str:
    m = re.search(r'id="materia"[^>]*>(.*?)(?:</article>|<footer)', pagina, re.S)
    if not m:
        return ""
    corpo = re.sub(r"<style.*?</style>", "", m.group(1), flags=re.S)
    blocos = re.split(r"</p>|<br\s*/?>|</h\d>|</div>", corpo)
    chave = sem_acento(titulo).upper()[:14]
    for b in blocos[:14]:
        t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", b))).strip(" *_-–")
        if (len(t) < 20 or sem_acento(t).upper().startswith(chave)
                or re.match(r"(?i)(procuradoria|gabinete|secretaria|camara municipal|prefeitura|estado do amazonas|municipio de)", sem_acento(t))
                or re.fullmatch(r"(?i)[,.\s]*(de\s+)?\d{1,2}\s*(º|o)?\s+de\s+\w+\s+de\s+\d{4}[.,\s]*", sem_acento(t))):
            continue
        if re.match(r"(?i)(o|a)\s+(prefeit|president|cidad|camara|vice)|fa[cç]o saber|faz saber|art\.?\s*1", t):
            break
        return t[:600]
    return ""


def acervo_aam(cache: dict) -> dict:
    """Leis publicadas no Diário Oficial dos Municípios do AM (61 municípios, sem Manaus). Incremental."""
    pagina = aam_get(AAM + "/pesquisar")
    corpo = re.search(r'name="busca_avancada\[entidade\]"[^>]*>(.*?)</select>', pagina, re.S)
    if not corpo:
        raise RuntimeError("lista de entidades do diário da AAM não encontrada")
    ents = [(i, html.unescape(n).strip()) for i, n in re.findall(r'<option value="(\d+)"[^>]*>([^<]*)', corpo.group(1))]
    ents = [e for e in ents if e[1].startswith(("Município de", "Câmara Municipal de"))]
    desde = cache.get("_ate") and (date.fromisoformat(cache["_ate"]) - timedelta(days=15)).isoformat() or "2009-01-01"
    hoje = date.today().isoformat()
    for eid, nome in ents:
        mun = re.sub(r"^(Município de|Câmara Municipal de)\s+", "", nome)
        pag, vistos = 1, 0
        while True:
            q = {"busca_avancada[dataInicio]": desde, "busca_avancada[dataFim]": hoje, "busca_avancada[titulo]": "LEI",
                 "busca_avancada[entidade]": eid, "busca_avancada[ordenacao]": "", "busca_avancada[pagina]": str(pag), "busca_avancada[Enviar]": ""}
            p = aam_get(AAM + "/pesquisar?" + urllib.parse.urlencode(q))
            m = re.search(r"de <strong>([\d\.]+)</strong>\s*matérias", p)
            total = int(m.group(1).replace(".", "")) if m else 0
            cards = re.findall(r'<li class="materia-card">(.*?)</li>', p, re.S)
            for card in cards:
                def campo(rx):
                    mm = re.search(rx, card, re.S)
                    return html.unescape(re.sub(r"\s+", " ", mm.group(1))).strip() if mm else ""
                cod = campo(r"<code>([^<]+)</code>")
                titulo = re.sub(r"<[^>]+>", "", campo(r'materia-card__titulo">\s*<a[^>]*>(.*?)</a>'))
                if cod and cod not in cache and tipo_lei(titulo):
                    cache[cod] = {"municipio": mun, "titulo": titulo, "circulacao": campo(r"<dt>Circulação</dt>\s*<dd>(.*?)</dd>")}
            vistos += len(cards)
            if not cards or vistos >= total:
                break
            pag += 1
    pendentes = [k for k, v in cache.items() if not k.startswith("_") and "ementa" not in v]
    log(f"[acervo_leis] diário da AAM: {len(pendentes)} leis novas para ler")
    for i, cod in enumerate(pendentes):
        try:
            cache[cod]["ementa"] = ementa_aam(aam_get(f"{AAM}/materia/{cod}"), cache[cod]["titulo"])
        except Exception as e:  # noqa: BLE001
            log(f"[acervo_leis] AAM {cod}: {e}")
        if i % 200 == 199:
            salvar("fontes/acervo_aam.json", cache)
            log(f"[acervo_leis] AAM: {i + 1} de {len(pendentes)}")
    cache["_ate"] = hoje
    salvar("fontes/acervo_aam.json", cache)
    return cache


def coletar_acervo_leis() -> dict:
    """Acervo de leis do Estado e dos municípios: SAPL da ALEAM, da CMM e de 9 câmaras, mais o diário da AAM.

    Inspirado no acervo de leonzordhue/leismunicipais e leonzordhue/leisestaduais, coletado das fontes oficiais."""
    por_lugar: dict = defaultdict(list)
    for lugar, base in ACERVO_SAPL.items():
        try:
            linhas = acervo_sapl(base)
            por_lugar[lugar] += linhas
            log(f"[acervo_leis] {lugar}: {len(linhas)} leis no SAPL")
        except Exception as e:  # noqa: BLE001
            log(f"[acervo_leis] {lugar}: {e}")
            antigo = ler(f"leis/{lugar}.json")
            if antigo:
                por_lugar[lugar] += [r for r in antigo if r[7] == "SAPL"]
    cache = ler("fontes/acervo_aam.json") or {}
    try:
        cache = acervo_aam(cache)
    except Exception as e:  # noqa: BLE001
        log(f"[acervo_leis] diário da AAM: {e} — mantendo o que já foi lido")
    nomes_mun = {}
    for cod, v in cache.items():
        if cod.startswith("_"):
            continue
        lugar = slug(NOMES_UE.get(sem_acento(v["municipio"]).upper(), v["municipio"]))
        nomes_mun[lugar] = v["municipio"]
        t = v["titulo"]
        num = re.search(r"N[º°oO.]*\s*(\d[\d\.]*)", t, re.I)
        ano = re.search(r"[/\-–]\s*(\d{4})\b|\bDE\s+(\d{4})\b", t, re.I)
        dt = v.get("circulacao") or ""
        ano_v = int(next(g for g in ano.groups() if g)) if ano else (int(dt[-4:]) if re.match(r"\d\d/\d\d/\d{4}", dt) else None)
        if str(v.get("ano") or "").isdigit():
            ano_v = int(v["ano"])
        numero = v.get("numero") or ((num.group(1).replace(".", "").lstrip("0") or "0") if num else "s/n")
        ementa = v.get("ementa") or ""
        if re.fullmatch(r"(?i)[,.\s]*(de\s+)?\d{1,2}\s*(º|o)?\s+de\s+\w+\s+de\s+\d{4}[.,\s]*", ementa):
            ementa = ""  # só a data da lei, sem ementa
        por_lugar[lugar].append([v.get("tipo") or tipo_lei(t), numero, ano_v, "", ementa, categoria(ementa) if ementa else "",
                                 v.get("url") or f"{AAM}/materia/{cod}", v.get("fonte_nome") or "DOM-AAM"])

    pop = {}
    try:
        r = jget("https://servicodados.ibge.gov.br/api/v3/agregados/4709/periodos/2022/variaveis/93?localidades=N6[N3[13]]")
        for x in r[0]["resultados"][0]["series"]:
            pop[slug(x["localidade"]["nome"].rsplit(" - ", 1)[0])] = int(x["serie"]["2022"])
    except Exception as e:  # noqa: BLE001
        log(f"[acervo_leis] população IBGE: {e}")

    pasta = DADOS / "leis"
    pasta.mkdir(parents=True, exist_ok=True)
    resumo = {}
    total = 0
    for lugar, linhas in por_lugar.items():
        # a mesma lei pode vir do SAPL e do diário: fica a do SAPL (ementa cadastrada pela câmara)
        unicas, vistas = [], set()
        for r in sorted(linhas, key=lambda r: r[7] != "SAPL"):
            k = (r[0], r[1], r[2])
            if r[1] != "s/n" and k in vistas:
                continue
            vistas.add(k)
            unicas.append(r)
        unicas.sort(key=lambda r: (-(r[2] or 0), -(int(r[1]) if str(r[1]).isdigit() else 0)))
        salvar(f"leis/{lugar}.json", unicas)
        total += len(unicas)
        por_ano = Counter(str(r[2]) for r in unicas if r[2])
        cats = Counter(r[5] for r in unicas if r[5])

        mudanca = r"\W*(altera|acrescenta|modifica|revoga|regulamenta|da nova redacao|inclui)"

        def lei_organica():
            # vale a lei do tipo Lei Orgânica cuja ementa fala dela (há câmaras que cadastram outras leis com esse tipo)
            cands = [r for r in unicas if r[0] == "Lei Orgânica" and not re.match(mudanca, sem_acento(r[4]))]
            boas = [r for r in cands if not re.match(r"\W*(autoriza|concede|denomina|declara|cria|fixa|estima|abre|institui o dia|reconhece)", sem_acento(r[4]))]
            falam = [r for r in boas if "organica" in sem_acento(r[4])]
            boas = falam or boas
            r = max(boas, key=lambda r: r[2] or 0) if boas else None
            return [r[0], r[1], r[2], r[4][:160], r[6]] if r else None

        def plano_diretor():
            for r in sorted(unicas, key=lambda r: -(r[2] or 0)):
                e = sem_acento(r[4])
                if not re.match(mudanca, e) and re.search(r"(institu\w*|dispoe sobre|aprova)\W+(a revisao d)?o?\W*(novo )?plano diretor", e):
                    return [r[0], r[1], r[2], r[4][:160], r[6]]
            # sem a lei principal no acervo: usa a citada nas leis que a alteram
            for r in unicas:
                m = re.search(r"(lei complementar|lei)\W+n\W*0*(\d+)\W+de\W+\d+\W+de\W+\w+\W+de\W+(\d{4})\W+que dispoe sobre (o )?plano diretor", sem_acento(r[4]))
                if m:
                    return [m.group(1).title(), m.group(2), int(m.group(3)), "Citada em lei que a altera; o texto original não está no acervo.", r[6]]
            return None

        resumo[lugar] = {
            "nome": "Estado do Amazonas" if lugar == "estado" else nomes_mun.get(lugar) or lugar.replace("-", " ").title(),
            "total": len(unicas), "por_ano": dict(sorted(por_ano.items())), "categorias": dict(cats.most_common()),
            "homenagens": sum(v for k, v in cats.items() if k in HOMENAGENS), "classificadas": sum(cats.values()),
            "fontes": sorted({r[7] for r in unicas}), "populacao": pop.get(lugar),
            "lei_organica": None if lugar == "estado" else lei_organica(),
            "plano_diretor": None if lugar == "estado" else plano_diretor(),
            "ultimas": [r for r in unicas[:8]],
        }
    salvar("leis/resumo.json", resumo)
    log(f"[acervo_leis] {total} leis em {len(resumo)} lugares")
    return {"leis": total, "lugares": len(resumo)}


# ------------------------------------------------------------------ main

FONTES_INFO = {
    "cmm": ("Câmara Municipal de Manaus (SAPL)", "https://sapl.cmm.am.gov.br"),
    "aleam": ("Assembleia Legislativa do Amazonas (SAPL)", "https://sapl.al.am.leg.br"),
    "camara": ("Câmara dos Deputados — Dados Abertos", "https://dadosabertos.camara.leg.br"),
    "senado": ("Senado Federal — Dados Abertos", "https://legis.senado.leg.br/dadosabertos"),
    "prefeituras": ("TSE — Candidaturas 2024 e ajustes com fonte", "https://dadosabertos.tse.jus.br"),
    "emendas": ("Portal da Transparência — Emendas parlamentares", "https://portaldatransparencia.gov.br/emendas"),
    "ceap_cmm": ("Câmara Municipal de Manaus — Cota parlamentar (SIGAE)", "https://www.cmm.am.gov.br/transparencia/#cotas-ceap"),
    "camara_atividade": ("Câmara dos Deputados — Cota, presença e votações", "https://dadosabertos.camara.leg.br/swagger/api.html#staticfile"),
    "eleicoes": ("TSE — Votos e bens declarados", "https://dadosabertos.tse.jus.br"),
    "ceap_aleam": ("Assembleia Legislativa do Amazonas — Cota parlamentar (CEAP)", "https://www.aleam.gov.br/transparencia/controle-de-cota-parlamentar/"),
    "presenca": ("Câmara Municipal de Manaus e ALEAM — Presença em sessões (SAPL)", "https://sapl.al.am.leg.br/sessao/pesquisar-sessao"),
    "senado_atividade": ("Senado Federal — Votações nominais e cota (CEAPS)", "https://adm.senado.gov.br/adm-dadosabertos"),
    "tse_historico": ("TSE — Candidaturas, bens, votos e fotos do Amazonas desde 2000", "https://dadosabertos.tse.jus.br"),
    "doacoes": ("TSE — Prestação de contas: quem financiou as campanhas (2018 em diante)", "https://dadosabertos.tse.jus.br/dataset/?q=prestacao+de+contas"),
    "votos_territorio": ("TSE — Votos por município e por bairro", "https://dadosabertos.tse.jus.br/dataset/?q=votacao+secao"),
    "acervo_leis": ("Acervo de leis: SAPL da ALEAM, da CMM e das câmaras, e Diário Oficial dos Municípios (AAM)", "https://www.diariomunicipal.com.br/aam/"),
    "tribunais": ("DadosJusBr e TCE-AM — Remuneração de membros do sistema de Justiça (coleta semestral)", "https://dadosjusbr.org"),
    "diarios": ("Diários oficiais: ALEAM, Câmara Municipal de Manaus e Estado do Amazonas", "https://diario.imprensaoficial.am.gov.br"),
}
# Fontes pesadas que só rodam quando pedidas pelo nome
SOB_DEMANDA = {"eleicoes", "tse_historico", "doacoes", "votos_territorio"}


def main() -> int:
    tarefas = {
        "cmm": lambda: coletar_sapl("cmm", "https://sapl.cmm.am.gov.br", "Vereador(a) de Manaus", "municipal", "Manaus"),
        "aleam": lambda: coletar_sapl("aleam", "https://sapl.al.am.leg.br", "Deputado(a) estadual", "estadual", None),
        "camara": coletar_camara,
        "senado": coletar_senado,
        "prefeituras": coletar_executivo,
        "emendas": coletar_emendas,  # depende de camara e senado
        "ceap_cmm": coletar_ceap_cmm,  # depende de cmm
        "camara_atividade": coletar_camara_atividade,  # depende de camara
        "ceap_aleam": coletar_ceap_aleam,  # depende de aleam
        "diarios": coletar_diarios,  # depende das casas
        "presenca": coletar_presenca,
        "senado_atividade": coletar_senado_atividade,  # depende de senado
        "tribunais": coletar_tribunais,
        "tse_historico": coletar_tse_historico,  # sob demanda, lê os arquivos do TSE em .cache
        "doacoes": coletar_doacoes,  # sob demanda, depois do histórico
        "acervo_leis": coletar_acervo_leis,
        "votos_territorio": coletar_votos_territorio,  # sob demanda, depois do histórico
        "eleicoes": coletar_eleicoes,  # sob demanda
    }
    meta_ant = ler("meta.json", {}) or {}
    fontes_meta = {f["id"]: f for f in meta_ant.get("fontes", [])}
    falhas = []
    escolhidas = set(sys.argv[1:]) or (set(tarefas) - SOB_DEMANDA)
    for chave, fn in tarefas.items():
        if chave not in escolhidas:
            continue
        try:
            resultado = fn()
            salvar(f"fontes/{chave}.json", resultado)
            nome, url = FONTES_INFO[chave]
            fontes_meta[chave] = {"id": chave, "nome": nome, "url": url, "atualizado_em": HOJE,
                                  "legislatura": resultado.get("legislatura")}
        except Pular as e:
            log(f"[{chave}] pulado: {e}")
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
        if dados and "politicos" in dados:
            politicos += dados["politicos"]
            normas += dados["normas"]
    emendas = (ler("fontes/emendas.json") or {}).get("emendas", {})
    ceap_cmm = ler("fontes/ceap_cmm.json") or {}
    atividade = ler("fontes/camara_atividade.json") or {}
    eleicoes = (ler("fontes/eleicoes.json") or {}).get("eleicoes", {})
    ceap_aleam = ler("fontes/ceap_aleam.json") or {}
    presenca = (ler("fontes/presenca.json") or {}).get("presenca", {})
    senado_at = ler("fontes/senado_atividade.json") or {}
    diarios = ler("fontes/diarios.json") or {}
    por_politico = defaultdict(list)
    for m in diarios.get("mencoes", []):
        por_politico[m["politico"]].append(m)
    for p in politicos:
        if p["id"] in emendas:
            p["emendas"] = emendas[p["id"]]
        if p["id"] in ceap_cmm.get("cota", {}):
            p["cota"] = ceap_cmm["cota"][p["id"]]
        if p["id"] in atividade.get("atividade", {}):
            a = atividade["atividade"][p["id"]]
            p["cota"] = a["cota"]
            p["presenca"] = a["presenca"]
            p["votacoes"] = a["votos"]
        if p["id"] in eleicoes:
            p["eleicao"] = eleicoes[p["id"]]
        if p["id"] in presenca:
            p["presenca"] = presenca[p["id"]]
        if p["id"] in senado_at.get("atividade", {}):
            a = senado_at["atividade"][p["id"]]
            p["presenca"], p["votacoes"], p["ausencias"] = a["presenca"], a["votos"], a["ausencias"]
            if a.get("cota"):
                p["cota"] = a["cota"]
        if p["id"] in ceap_aleam.get("cota", {}) and "cota" not in p:
            p["cota"] = ceap_aleam["cota"][p["id"]]
        if por_politico.get(p["id"]):
            ms = por_politico[p["id"]]
            p["diario"] = {"total": len(ms), "por_tipo": dict(Counter(m["tipo"] for m in ms).most_common()),
                           "recentes": [{k: m[k] for k in ("diario", "edicao", "data", "url", "tipo", "trecho")} for m in ms[:8]]}
    # Notas fiscais da cota, das duas casas, num arquivo próprio (só a página de gastos carrega)
    salvar("diario.json", {"edicoes": diarios.get("edicoes", []), "mencoes": diarios.get("mencoes", [])})
    notas = ceap_cmm.get("notas", []) + atividade.get("notas", []) + ceap_aleam.get("notas", []) + senado_at.get("notas", [])
    ligar_pessoas(politicos)
    if ler("fontes/tribunais.json"):
        salvar("tribunais.json", ler("fontes/tribunais.json")["tribunais"])
    nomear_fornecedores(notas, politicos)
    salvar("gastos.json", sorted(notas, key=lambda n: n.get("data") or "", reverse=True))
    normas.sort(key=lambda n: n.get("data") or "", reverse=True)
    executivo = json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))
    salvar("politicos.json", politicos)
    salvar("normas.json", normas)
    try:
        montar_partidos()
    except Exception as e:  # noqa: BLE001
        log(f"[partidos] FALHOU: {e} — mantendo dados anteriores")
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
