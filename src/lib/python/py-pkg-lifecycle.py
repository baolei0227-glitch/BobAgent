#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BobWork Python 包生命周期清理脚本

职责：清理「AI 通过 run_command 安装、且超过 N 天未再被 import」的第三方包，
防止 site-packages 无限膨胀（曾实测 2.1GB）。

判定规则（全部满足才删）：
  1. 台账（.bob-pkg-usage.json）中存在该包的 installed 日期（= 确认是 AI 装的）；
  2. installed 距今超过 --days 天（观察期，默认 30 天）；
  3. 该包所有顶层模块的最近 import 日期均超过 --days 天（未使用）；
  4. 不在 --protected 保护名单（BobWork 自身依赖）内。

台账由两部分写入：
  - TS 侧 recordPipInstall：pip 安装成功后写 installed 日期；
  - usercustomize.py（导入追踪钩子）：每次 python 运行记录顶层模块 lastUsed 日期。

用法：
  python3 py-pkg-lifecycle.py purge --days 30 --protected a,b,c [--dry-run]
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

SITE = os.path.join(os.path.expanduser("~"), "Library", "Python", "3.9",
                    "lib", "python", "site-packages")
LEDGER = os.path.join(SITE, ".bob-pkg-usage.json")
LOCK = os.path.join(SITE, ".bob-pkg-cleanup.lock")


def load_ledger():
    try:
        with open(LEDGER, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def save_ledger(data):
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, LEDGER)


def acquire_lock():
    """互斥锁：防止与另一个清理进程并发（pip 操作不并发）。"""
    try:
        os.mkdir(LOCK)
        with open(os.path.join(LOCK, "pid"), "w") as f:
            f.write(str(os.getpid()))
        return True
    except FileExistsError:
        return False


def release_lock():
    try:
        os.unlink(os.path.join(LOCK, "pid"))
    except Exception:
        pass
    try:
        os.rmdir(LOCK)
    except Exception:
        pass


def build_pkg_map():
    """返回 (pkg_to_mods, mod_to_pkgs)：
    pip 包名(小写) -> 顶层模块名集合；模块名 -> pip 包名集合。
    数据源：dist-info/top_level.txt（缺失时回退解析 RECORD 首段路径）。
    """
    pkg_to_mods = {}
    mod_to_pkgs = {}
    try:
        from importlib import metadata
    except ImportError:  # Python < 3.8 兜底（本机 3.9 走不到）
        import importlib_metadata as metadata

    for dist in metadata.distributions():
        name = (dist.metadata.get("Name") or "").strip().lower()
        if not name:
            continue
        mods = []
        try:
            tops = dist.read_text("top_level.txt")
        except Exception:
            tops = None
        if tops:
            mods = [ln.strip() for ln in tops.splitlines() if ln.strip()]
        if not mods:
            try:
                rec = dist.read_text("RECORD") or ""
            except Exception:
                rec = ""
            seen = set()
            for line in rec.splitlines():
                p = line.split(",")[0].strip()
                if not p or p.startswith(".."):
                    continue
                seg = p.split("/")[0]
                if not seg or seg in seen:
                    continue
                if seg.endswith((".dist-info", ".egg-info", ".data")) or seg.endswith((".py", ".so")):
                    continue
                seen.add(seg)
                mods.append(seg)
                if len(mods) >= 30:
                    break
        for m in mods:
            pkg_to_mods.setdefault(name, set()).add(m)
            mod_to_pkgs.setdefault(m, set()).add(name)
    return pkg_to_mods, mod_to_pkgs


def cmd_purge(args):
    days = max(1, args.days)
    dry_run = bool(args.dry_run)
    protected = {p.lower() for p in (args.protected or "").split(",") if p.strip()}

    today = datetime.date.today()
    cutoff = today - datetime.timedelta(days=days)

    data = load_ledger()
    if not data:
        print(json.dumps({"removed": [], "candidates": 0, "dryRun": dry_run}, ensure_ascii=False))
        return 0

    meta = data.get("_meta")
    if not isinstance(meta, dict):
        meta = {}
    pkg_to_mods, _ = build_pkg_map()

    removed, candidates = [], 0
    for pkg, entry in sorted(data.items()):
        if pkg == "_meta" or not isinstance(entry, dict) or "installed" not in entry:
            continue  # 非 AI 安装（仅 lastUsed）→ 永不自动删
        candidates += 1
        if pkg.lower() in protected:
            continue
        try:
            installed = datetime.date.fromisoformat(entry["installed"])
        except Exception:
            continue  # 安装日期缺失/非法 → 保守跳过
        if installed > cutoff:
            continue  # 观察期内 → 跳过

        # 最近使用 = 该包所有顶层模块 lastUsed 的最大值
        mods = pkg_to_mods.get(pkg, set())
        last_used = ""
        for m in mods:
            e = data.get(m)
            if isinstance(e, dict) and e.get("lastUsed"):
                if e["lastUsed"] > last_used:
                    last_used = e["lastUsed"]
        used_recently = False
        if last_used:
            try:
                used_recently = datetime.date.fromisoformat(last_used) > cutoff
            except Exception:
                used_recently = False
        if used_recently:
            continue

        removed.append(pkg)
        if not dry_run:
            try:
                subprocess.run(
                    [sys.executable, "-m", "pip", "uninstall", "-y", pkg],
                    capture_output=True, timeout=120,
                )
            except Exception:
                pass

    if dry_run:
        # 干跑：只扫描不卸载、不改台账
        print(json.dumps({
            "removed": removed,
            "candidates": candidates,
            "days": days,
            "dryRun": True,
        }, ensure_ascii=False))
        return 0

    if removed:
        for p in removed:
            data.pop(p, None)
            # 该包专属的模块记录一并清掉（保留不影响判定，但保持台账干净）
            for m in list(data.keys()):
                if m == "_meta":
                    continue
                if m.lower() == p.lower():
                    data.pop(m, None)

    meta["lastCleanup"] = datetime.datetime.now().astimezone().isoformat(timespec="minutes")
    meta["lastRemoved"] = removed
    data["_meta"] = meta
    save_ledger(data)

    print(json.dumps({
        "removed": removed,
        "candidates": candidates,
        "days": days,
        "dryRun": False,
        "lastCleanup": meta["lastCleanup"],
    }, ensure_ascii=False))
    return 0


def main():
    parser = argparse.ArgumentParser(description="BobWork Python 包生命周期清理")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("purge", help="清理超过 N 天未使用的 AI 安装包")
    p.add_argument("--days", type=int, default=30, help="未使用天数阈值（默认 30）")
    p.add_argument("--protected", type=str, default="", help="保护名单（逗号分隔，不清理）")
    p.add_argument("--dry-run", action="store_true", help="只扫描不卸载")
    args = parser.parse_args()

    if args.command == "purge":
        if not acquire_lock():
            print(json.dumps({"error": "another cleanup is running"}, ensure_ascii=False))
            return 1
        try:
            return cmd_purge(args)
        finally:
            release_lock()
    return 1


if __name__ == "__main__":
    sys.exit(main())
