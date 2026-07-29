"""
agent_with_tools.py — 完整 Agent 集成示例

整合三套系统：
  thinking_level.py  → 思考深度控制
  skill_core         → 技能系统
  agent_tools.py     → 工具调用

展示如何构建一个「会思考、会动手、会用技能」的 Agent。

用法：
  python agent_with_tools.py "帮我查一下当前目录有哪些 Python 文件"
  python agent_with_tools.py --level high "分析这个项目的文件结构"
"""

import os
import sys
import json
import argparse
import time
from pathlib import Path
from typing import Optional

try:
    from openai import OpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    OpenAI = None  # type: ignore

# 导入三套系统
sys.path.insert(0, str(Path(__file__).parent))

from thinking_level import (
    ThinkingLevel,
    build_thinking_config,
    ThinkingDisplayConfig,
)
from agent_tools import (
    Tool,
    ToolRegistry,
    ToolCallLoop,
    ToolUsageTracker,
)

# 可选导入 skill_core
try:
    from skill_core import SkillManager
    SKILL_AVAILABLE = True
except ImportError:
    SKILL_AVAILABLE = False


# ============================================================
# 1. 定义工具
# ============================================================

def read_file(path: str) -> str:
    """
    读取文件内容。

    Args:
        path: 文件路径（相对或绝对）
    """
    p = Path(path).expanduser()
    if not p.exists():
        return f"文件不存在: {path}"
    try:
        content = p.read_text(encoding='utf-8')
        if len(content) > 5000:
            content = content[:5000] + f"\n...(截断, 共 {len(content)} 字符)"
        return content
    except Exception as e:
        return f"读取失败: {e}"


def list_directory(path: str = ".") -> str:
    """
    列出目录内容。

    Args:
        path: 目录路径，默认为当前目录
    """
    p = Path(path).expanduser()
    if not p.is_dir():
        return f"不是目录: {path}"
    entries = []
    for entry in sorted(p.iterdir()):
        suffix = "/" if entry.is_dir() else ""
        size = ""
        if entry.is_file():
            try:
                s = entry.stat().st_size
                if s < 1024:
                    size = f" ({s}B)"
                elif s < 1024 * 1024:
                    size = f" ({s/1024:.1f}KB)"
                else:
                    size = f" ({s/1024/1024:.1f}MB)"
            except Exception:
                pass
        entries.append(f"  {entry.name}{suffix}{size}")
    return "\n".join(entries) if entries else "(空目录)"


def search_files(pattern: str, path: str = ".") -> str:
    """
    搜索匹配模式的文件。

    Args:
        pattern: 搜索模式，例如 "*.py"
        path: 搜索起始目录
    """
    import glob
    p = Path(path).expanduser()
    results = list(p.rglob(pattern))
    if not results:
        return f"未找到匹配 '{pattern}' 的文件"
    lines = [str(r) for r in results[:30]]
    if len(results) > 30:
        lines.append(f"... 还有 {len(results) - 30} 个文件")
    return "\n".join(lines)


def run_command(cmd: str) -> str:
    """
    执行一条 shell 命令并返回结果。

    Args:
        cmd: 要执行的命令，例如 "ls -la"
    """
    import subprocess
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=30
        )
        output = result.stdout
        if result.stderr:
            output += "\n[stderr]\n" + result.stderr
        if not output.strip():
            output = "(无输出)"
        if len(output) > 3000:
            output = output[:3000] + f"\n...(截断)"
        return output
    except subprocess.TimeoutExpired:
        return "命令超时（30秒）"
    except Exception as e:
        return f"执行失败: {e}"


def web_search(query: str) -> str:
    """
    搜索网页信息。

    Args:
        query: 搜索关键词
    """
    return f'[模拟搜索] 搜索: "{query}" → 这里应该是实际的搜索结果'


# ============================================================
# 2. 构建工具注册表
# ============================================================

def build_tool_registry() -> ToolRegistry:
    """构建默认工具集。"""
    registry = ToolRegistry()
    registry.register_all([
        Tool.from_function(read_file, category="文件"),
        Tool.from_function(list_directory, category="文件"),
        Tool.from_function(search_files, category="文件"),
        Tool.from_function(run_command, category="系统"),
        # web_search 注释掉，避免实际网络调用
        # Tool.from_function(web_search, category="网络"),
    ])
    return registry


# ============================================================
# 3. 构建系统提示
# ============================================================

BASE_SYSTEM_PROMPT = """你是一个能使用工具的智能助手。
当用户的问题需要读取文件、列出目录、搜索文件或执行命令时，
请主动使用相应的工具来获取信息，然后基于工具返回的结果回答用户。"""


def build_full_system_prompt(
    user_input: str,
    thinking_level: ThinkingLevel,
    agent_id: str = "default",
) -> str:
    """构建包含思考层级 + 技能上下文的完整系统提示。"""
    parts = [BASE_SYSTEM_PROMPT]

    # Layer 1: 思考层级
    config = build_thinking_config(thinking_level)
    if config.system_prompt_injection:
        parts.append(config.system_prompt_injection)

    # Layer 2: 技能上下文（如果 skill_core 可用）
    if SKILL_AVAILABLE:
        manager = SkillManager()
        if manager.discover_and_load() > 0:
            manager.enable_all_skills(agent_id)
            matches, ctx = manager.match_and_build(user_input, agent_id)
            if ctx:
                parts.append(ctx)

    return "\n\n".join(parts)


# ============================================================
# 4. 带工具计数的输出处理
# ============================================================

class ToolAwareDisplay:
    """
    处理带有工具计数的输出展示。

    这是你要的「🔧 N 个工具」效果的核心实现。
    """

    def __init__(self, thinking_config: ThinkingDisplayConfig):
        self.thinking_config = thinking_config
        self.think_started = False
        self.think_ended = False
        self._text_buffer = ""

    def on_text(self, text: str):
        """处理文本片段（流式输出时使用）。"""
        self._text_buffer += text
        print(text, end="", flush=True)

    def on_tool_call(self, tool_name: str, arguments: dict):
        """工具被调用时。"""
        if not self.think_ended and self.think_started:
            # 还在思考阶段，结束思考块
            self._end_think_block()

        args_str = json.dumps(arguments, ensure_ascii=False)
        print(f"\n  🔨 调用: {tool_name}({args_str})", flush=True)

    def on_tool_result(self, tool_name: str, result: str, duration_ms: float):
        """工具执行完成时。"""
        preview = result[:200].replace('\n', ' ')
        print(f"  ✓ 完成 ({duration_ms:.0f}ms): {preview}", flush=True)

    def start_think_block(self):
        """开始思考块。"""
        if not self.thinking_config.show_think_block:
            return
        self.think_started = True
        print("\n" + "━" * 50)
        print("💭 思考过程:")
        print("━" * 50)

    def _end_think_block(self):
        """结束思考块。"""
        if self.think_ended:
            return
        self.think_ended = True
        print("\n" + "━" * 50)

    def show_tool_summary(self, tracker: ToolUsageTracker):
        """展示工具使用摘要 —— 这就是你要的「🔧 N 个工具」。"""
        if tracker.total_calls == 0:
            return
        print(f"\n{tracker.summary}")

    def start_answer_block(self, tracker: ToolUsageTracker):
        """开始回答块，附带工具摘要。"""
        print("\n" + "━" * 50)
        self.show_tool_summary(tracker)
        print("💬 回答:")
        print("━" * 50)


# ============================================================
# 5. 主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="带工具调用的 Agent 示例")
    parser.add_argument("prompt", nargs="*", help="问题")
    parser.add_argument(
        "--level", "-l",
        default="medium",
        choices=[e.value for e in ThinkingLevel],
        help="思考深度",
    )
    parser.add_argument("--stream", action="store_true", help="流式输出")
    parser.add_argument("--model", default="deepseek-chat", help="模型 ID")
    parser.add_argument("--base-url", default="https://api.deepseek.com", help="API 地址")
    args = parser.parse_args()

    prompt = " ".join(args.prompt) if args.prompt else input("> ")
    api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("请设置 DEEPSEEK_API_KEY 环境变量")
        sys.exit(1)

    if not OPENAI_AVAILABLE:
        print("需要安装 openai 库：pip install openai")
        sys.exit(1)

    level = ThinkingLevel(args.level)
    thinking_config = build_thinking_config(level)

    print(f"\n🧠 思考深度: {level.label}")
    print(f"🛠  可用工具: {build_tool_registry().count()} 个")
    print()

    # 初始化
    client = OpenAI(base_url=args.base_url, api_key=api_key)
    registry = build_tool_registry()
    tracker = ToolUsageTracker()
    loop = ToolCallLoop(
        client=client,
        model=args.model,
        registry=registry,
        tracker=tracker,
    )
    display = ToolAwareDisplay(thinking_config.display)

    # 构建消息
    system_prompt = build_full_system_prompt(prompt, level)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    if args.stream:
        # 流式 + 工具调用
        display.start_think_block()
        final_text, all_msgs = loop.run_stream(
            messages,
            on_text=display.on_text,
            on_tool_call=display.on_tool_call,
            on_tool_result=display.on_tool_result,
        )
        display.start_answer_block(tracker)
        # 流式输出已经在 on_text 中处理，这里不需要二次输出
    else:
        # 非流式
        final_text, all_msgs = loop.run(messages)
        display.start_answer_block(tracker)
        print(final_text)

    # 调试：展示完整消息历史
    if args.stream:
        print(f"\n\n📊 统计: {len(all_msgs)} 条消息, {tracker.total_calls} 次工具调用")
        for i, msg in enumerate(all_msgs):
            role = msg["role"]
            if role == "tool":
                print(f"  [{i}] tool: {msg['content'][:100]}...")
            elif role == "assistant" and "tool_calls" in msg:
                names = [tc["function"]["name"] for tc in msg["tool_calls"]]
                print(f"  [{i}] assistant → 调用: {', '.join(names)}")


if __name__ == "__main__":
    main()
