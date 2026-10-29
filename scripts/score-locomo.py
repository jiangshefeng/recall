"""Score a pilot report with the pinned upstream LoCoMo QA functions, without heavy BERT dependencies."""
import ast
import hashlib
import json
import os
from pathlib import Path
import string
import sys
from collections import Counter

if os.environ.get("LOCOMO_PYTHON_PACKAGES"):
    sys.path.insert(0, os.environ["LOCOMO_PYTHON_PACKAGES"])
import numpy as np
import regex
import nltk
from nltk.stem import PorterStemmer

report_path = Path(sys.argv[1]).resolve()
official = Path(sys.argv[2]).resolve()
tree = ast.parse(official.read_text(encoding="utf-8"))
names = {"normalize_answer", "f1_score", "f1", "eval_question_answering"}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert {node.name for node in functions} == names
namespace = {"np": np, "regex": regex, "string": string, "Counter": Counter, "ps": PorterStemmer()}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(official), "exec"), namespace)
report = json.loads(report_path.read_text(encoding="utf-8-sig"))
scores = {"status": report["status"], "sample": report["manifest"]["sample"], "arms": {}}
for arm in ["dynamic", "raw", "raw3", "mem0"]:
    rows = []
    for result in report["results"]:
        output = result.get(arm, {})
        if output.get("error") or "answer" not in output:
            continue
        qa = result["qa"]
        row = dict(qa, answer=qa.get("answer", "No information available"), prediction=output["answer"])
        value = namespace["eval_question_answering"]([row], "prediction")[0][0]
        rows.append({"index": result["index"], "category": qa["category"], "score": float(value), "question": qa["question"],
                     "gold": row["answer"], "answer": output["answer"], "provenanceRecall": output.get("provenanceRecall")})
    average = lambda values: sum(values) / len(values) if values else None
    categories = {str(category): {"count": len(subset := [row for row in rows if row["category"] == category]),
                  "mean": average([row["score"] for row in subset])} for category in range(1, 6)}
    scores["arms"][arm] = {"completed": len(rows), "errorsOrMissing": len(report["results"]) - len(rows), "categories": categories,
                          "meanAcrossFiveCategories": average([row["score"] for row in rows]),
                          "f1Categories1to4": average([row["score"] for row in rows if row["category"] != 5]),
                          "provenanceRecallCategories1to4": average([row["provenanceRecall"] for row in rows if row["category"] != 5 and row["provenanceRecall"] is not None]), "rows": rows}
scores["scoring"] = "Pinned upstream Python functions, unchanged: category-specific stemmed token F1 for 1-4; exact upstream abstention phrase check for 5. Five-category mean mixes metrics; not accuracy. Service errors excluded and counted separately."
scores["scoringVersions"] = {"nltk": nltk.__version__, "regex": regex.__version__, "numpy": np.__version__,
                             "officialSourceSha256": hashlib.sha256(official.read_bytes()).hexdigest()}
output = report_path.with_name("scores.json")
output.write_text(json.dumps(scores, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({arm: {k: v for k, v in data.items() if k != "rows"} for arm, data in scores["arms"].items()}, ensure_ascii=False, indent=2))
