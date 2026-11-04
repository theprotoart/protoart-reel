"""ProtoArt Reel: download the 4-bit FLUX.2 [klein] 4B that Protoart Studio uses (one pinned revision), or one of
Qwen's own Qwen2.5 instruct models for Reel's writer, into the shared Hugging Face cache. Run only when the person presses GET FLUX. Prints one JSON line when finished.

  argv: <hub cache folder> <repo> <revision>
"""
import json
import sys

ALLOWED = {("ar9av/FLUX.2-klein-4B-mflux-4bit", "86214a1c1caaea43b7c25b452b74ec08cd33d3e7"),
           # Reel's writer (titles, descriptions, chapters): Qwen's own instruct models, small to large
           ("Qwen/Qwen2.5-1.5B-Instruct", "main"), ("Qwen/Qwen2.5-3B-Instruct", "main"), ("Qwen/Qwen2.5-7B-Instruct", "main")}
PATTERNS = ["transformer/*", "text_encoder/*", "vae/*", "tokenizer/*", "*.json", "*.jinja"]
TEXT_PATTERNS = ["*.json", "*.safetensors", "merges.txt", "vocab.json", "tokenizer*", "*.jinja"]


def main():
    cache, repo, rev = sys.argv[1], sys.argv[2], sys.argv[3]
    if (repo, rev) not in ALLOWED:
        print(json.dumps({"type": "error", "msg": "not an allowed model"}), flush=True)
        sys.exit(2)
    try:
        from huggingface_hub import snapshot_download
        path = snapshot_download(repo_id=repo, revision=rev, cache_dir=cache, allow_patterns=TEXT_PATTERNS if repo.startswith("Qwen/") else PATTERNS)
        print(json.dumps({"type": "fetched", "path": path}), flush=True)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"type": "error", "msg": f"{type(e).__name__}: {e}"}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
