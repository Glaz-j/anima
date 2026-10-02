"""Prepare five local fictional role corpora. No private messages or model calls."""
from __future__ import annotations
import csv
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/roles"
RESEARCH = ROOT / "data/public/fictional-characters/research-20261001"
ROLEBENCH_REVISION = "a57ed54f9613921e4a5f1b63601a558cd5acf971"
ROLEBENCH_HASHES = {
    "Sheldon Cooper.jsonl": "9407f3e0297450e11e684b2bde746c8edb78f76a6badd3eb64e55717a00987c3",
    "Sherlock Holmes.jsonl": "dca0ef4eac05bae9c477c5260ec1cd29aa4a521ad71cd9037fe767a3e255b335",
    "Wade Wilson.jsonl": "d517a554d97df5af84ba6b9606dfae8f80591de5ea9c22efef0af51854e7dd07",
}
ROLES = [
    dict(id="sheldon", name="谢耳朵", englishName="Sheldon Cooper", work="生活大爆炸", version="RoleBench 剧本片段", color="#d8eacc", mark="Sh", aliases=["Sheldon Cooper"], language="en", file="Sheldon Cooper.jsonl", seed="规则、精确、学术自尊与不熟练的关心。保留关系中的温度，避免每句话都纠错或只会说物理。"),
    dict(id="sherlock", name="福尔摩斯", englishName="Sherlock Holmes", work="大侦探福尔摩斯", version="电影版 · RoleBench", color="#d8dcef", mark="Ho", aliases=["Sherlock Holmes"], language="en", file="Sherlock Holmes.jsonl", seed="以材料里的电影版本为准。好奇、观察、假设验证、冷幽默；只能依据对方提供的细节推理，不能假装看到用户衣着、房间或身体。"),
    dict(id="deadpool", name="死侍", englishName="Wade Wilson", work="Deadpool", version="电影剧本 · Wade / DEADPOOL", color="#f1d3d1", mark="DP", aliases=["Wade Wilson", "DEADPOOL"], language="en", file="Wade Wilson.jsonl", seed="嘴碎、自嘲、跳跃比喻和打破第四面墙；幽默是情绪的掩护，对亲近者有认真一面。不把每次聊天变成暴力、性笑话或无差别辱骂。"),
    dict(id="lvziqiao", name="吕子乔", englishName="Lü Ziqiao", work="爱情公寓", version="CPED · TV_ID 27", color="#f2e0b8", mark="乔", aliases=["吕子乔"], language="zh", tv_id="27", seed="本次只用 TV_ID 27 的早期片段。自信、社交、机变、爱占小便宜但在朋友关系中会露出认真；不引入后期婚育阶段。"),
    dict(id="huyifei", name="胡一菲", englishName="Hu Yifei", work="爱情公寓", version="CPED · TV_ID 27", color="#e4d6ed", mark="菲", aliases=["胡一菲"], language="zh", tv_id="27", seed="本次只用 TV_ID 27。直率、好胜、识破借口、行动式关心；语气有锋芒但不是对所有人持续发火。避免后来季数的剧情。"),
]

def jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

def windows(messages, limit=22):
    """Keep whole conversations when short; bounded, overlapping windows otherwise."""
    for start in range(0, len(messages), limit - 3):
        part = messages[start:start + limit]
        if any(m["isTarget"] for m in part):
            yield part
        if start + limit >= len(messages):
            break

def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / "scripts/datasets"))
    from inspect_cped import download
    download(ROOT / "data/public/cped")
    cped_groups = defaultdict(list)
    cped_hashes = {}
    for path in sorted((ROOT / "data/public/cped/raw").glob("*_split.csv")):
        cped_hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        with path.open(encoding="utf-8-sig", newline="") as file:
            for row in csv.DictReader(file):
                if row["TV_ID"] == "27":
                    cped_groups[row["Dialogue_ID"]].append(row)
    if not cped_groups:
        raise ValueError("CPED 原始数据不存在，请先运行 scripts/datasets/inspect_cped.py")
    expected_cped = json.loads((ROOT / "data/public/cped/download-manifest.json").read_text(encoding="utf-8"))
    # The existing manifest wraps files in a dictionary in some preparation versions.
    if isinstance(expected_cped, dict):
        expected_cped = expected_cped.get("files", expected_cped.get("sources", []))
    for entry in expected_cped:
        name = entry.get("file", entry.get("path"))
        if name in cped_hashes and cped_hashes[name] != entry["sha256"]:
            raise ValueError("CPED checksum changed: " + name)
    catalogue = []
    for role in ROLES:
        directory = OUTPUT / role["id"]
        if (directory / "corpus.jsonl").exists():
            raise ValueError("角色材料已存在，不覆盖：" + str(directory))
        directory.mkdir(exist_ok=True)
        groups = defaultdict(list)
        source_hashes = {}
        source_count = 0
        if "file" in role:
            relative = "rolebench/" + role["file"]
            path = RESEARCH / "raw" / relative
            if not path.exists():
                path = ROOT / "data/public/rolebench/raw" / role["file"]
            if path.exists():
                body = path.read_bytes()
            else:
                remote = "profiles-eng/profiles-eng-" + role["file"]
                url = "https://huggingface.co/datasets/ZenMoore/RoleBench/resolve/" + ROLEBENCH_REVISION + "/" + urllib.parse.quote(remote)
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Anima-role-preparation"}), timeout=60) as response:
                    body = response.read(12000001)
                if len(body) > 12000000:
                    raise ValueError("Unexpected source size: " + remote)
            if hashlib.sha256(body).hexdigest() != ROLEBENCH_HASHES[role["file"]]:
                raise ValueError("RoleBench checksum changed: " + relative)
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
            source_hashes[relative] = ROLEBENCH_HASHES[role["file"]]
            section = 0
            previous_act = None
            for index, row in enumerate(jsonl(path)):
                if row["act_id"] != previous_act or row["role"].lower() == "scene":
                    section += 1
                    previous_act = row["act_id"]
                is_target = row["role"] in role["aliases"]
                source_count += is_target
                narration = row["role"].lower() in {"scene", "narration", "narrator"}
                # Narration is background, never a target's spoken line or known private thought.
                groups[f"act{row['act_id']}:section{section}"].append(dict(
                    speaker=row["role"], text=row["content"][:1000 if narration else 2500],
                    isTarget=is_target, kind="background" if narration else "dialogue",
                    sourceIndex=index + 1, actId=row["act_id"], dialogueId=row["diag_id"],
                ))
            source = dict(dataset="RoleBench", revision="a57ed54f9613921e4a5f1b63601a558cd5acf971", file=relative,
                          url="https://huggingface.co/datasets/ZenMoore/RoleBench", hashes=source_hashes)
        else:
            source_hashes = cped_hashes
            for dialogue_id, rows in cped_groups.items():
                if not any(r["Speaker"] == role["name"] for r in rows):
                    continue
                for row in sorted(rows, key=lambda r: int(r["Utterance_ID"].rsplit("_", 1)[-1])):
                    is_target = row["Speaker"] == role["name"]
                    source_count += is_target
                    groups[dialogue_id].append(dict(speaker=row["Speaker"], text=row["Utterance"], isTarget=is_target,
                                                    kind="dialogue", sourceIndex=row["Utterance_ID"], scene=row["Scene"]))
            source = dict(dataset="CPED", revision="1e4b81c28a123f22387e06664f37e5dc9322380f", tvId="27",
                          url="https://github.com/scutcyr/CPED", hashes=source_hashes)
        corpus = []
        for group_id, messages in groups.items():
            for window_index, part in enumerate(windows(messages)):
                corpus.append(dict(id=f"{role['id']}:{group_id}:{window_index}", roleId=role["id"], groupId=group_id,
                                   messages=part, text="\n".join(m["speaker"] + ": " + m["text"] for m in part),
                                   source=source["dataset"], language=role["language"]))
        if not corpus:
            raise ValueError("角色没有语料：" + role["id"])
        (directory / "corpus.jsonl").write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in corpus), encoding="utf-8")
        info = {k: v for k, v in role.items() if k != "file"}
        info.update(source=source, targetUtterances=source_count, evidenceChunks=len(corpus),
                    buildMethod="yourself-skill-inspired evidence-grounded profile; not fine-tuning", profileStatus="pending")
        (directory / "role.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # Evenly distributed complete windows, capped independently of the total corpus size.
        selected = sorted(set(round(i * (len(corpus) - 1) / min(47, len(corpus) - 1)) for i in range(min(48, len(corpus))))) if len(corpus) > 1 else [0]
        sample = []
        for i in selected:
            chunk = corpus[i]
            # Center sample on a target turn so long preceding narration cannot crowd it out.
            own = next(j for j, m in enumerate(chunk["messages"]) if m["isTarget"])
            start = max(0, own - 3)
            excerpt = "\n".join(m["speaker"] + ": " + m["text"][:420] for m in chunk["messages"][start:start + 9])
            sample.append(dict(id=chunk["id"], text=excerpt[:1900]))
        (directory / "analysis-sample.json").write_text(json.dumps(sample, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        catalogue.append(info)
        print(f"{role['name']}: {source_count} target rows, {len(corpus)} evidence windows, {len(sample)} analysis samples")
    (OUTPUT / "catalogue.json").write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
