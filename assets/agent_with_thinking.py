"""
agent_with_thinking.py — 集成 thinking_level 的完整 Agent 示例

展示如何把 thinking_level.py 嵌入到 Agent 的：
  1. 系统提示构建
  2. API 调用
  3. 流式响应处理
  4. 前端展示

用法：
  python agent_with_thinking.py --level medium "你的问题"
  python agent_with_thinking.py --level max "复杂问题"
  python agent_with_thinking.py --level off "简单问题"
"""

import os
import sys
import argparse
from typing import Optional

try:
    from openai import OpenAI
except ImportError:
    print("pip install openai")
    sys.exit(1)

from thinking_level import (
    ThinkingLevel,
    build_thinking_config,
    ThinkingDisplayConfig,
)

# ---- Agent 的基础系统提示（不包含思考指令） ----
BASE_SYSTEM_PROMPT = """你是一个有帮助的 AI 助手。"""


def build_full_system_prompt(level: ThinkingLevel) -> str:
    """构建完整的系统提示：基础提示 + 思考指令。"""
    config = build_thinking_config(level)
    base = BASE_SYSTEM_PROMPT
    if config.system_prompt_injection:
        base += "\n" + config.system_prompt_injection
    return base


def build_api_params(level: ThinkingLevel, messages: list, model: str):
    """根据 thinking_level 构建 API 调用参数。"""
    config = build_thinking_config(level)
    params = {
        "model": model,
        "messages": messages,
    }
    if config.reasoning_effort is not None:
        params["reasoning_effort"] = config.reasoning_effort
    return params


# ---- 流式响应处理 ----

def handle_stream(response, display: ThinkingDisplayConfig):
    """处理流式响应，区分思考内容和回答内容。"""
    in_think = False
    in_mood = False
    mood_started = False
    think_started = False

    for chunk in response:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta is None:
            continue

        reasoning = getattr(delta, "reasoning_content", None) or ""
        content = getattr(delta, "content", None) or ""

        # 处理思考内容（reasoning_content 字段）
        if reasoning and display.show_think_block:
            if not think_started:
                print("\n" + "━" * 50)
                print("💭 思考过程:")
                print("━" * 50)
                think_started = True
            # 灰色输出
            print("\033[90m" + reasoning + "\033[0m", end="", flush=True)

        # 处理回答内容
        if content:
            if think_started and not in_think:
                # 思考结束
                print("\n" + "━" * 50)
                print("💬 回答:")
                print("━" * 50)
            print(content, end="", flush=True)

    print()


# ---- 非流式响应处理 ----

def handle_non_stream(response, display: ThinkingDisplayConfig):
    """处理非流式响应。"""
    choice = response.choices[0]

    # 思考内容
    reasoning = getattr(choice.message, "reasoning_content", None)
    if reasoning and display.show_think_block:
        print("━" * 50)
        print("💭 思考过程:")
        print("━" * 50)
        print("\033[90m" + reasoning + "\033[0m")
        print("━" * 50)
        print("💬 回答:")
        print("━" * 50)

    # 回答内容
    print(choice.message.content)


# ---- 主入口 ----

def main():
    parser = argparse.ArgumentParser(description="带思考深度的 Agent 示例")
    parser.add_argument("prompt", nargs="*", help="问题")
    parser.add_argument(
        "--level", "-l",
        default="medium",
        choices=[e.value for e in ThinkingLevel],
        help="思考深度",
    )
    parser.add_argument("--stream", action="store_true", help="流式输出")
    parser.add_argument("--model", default="deepseek-reasoner", help="模型 ID")
    parser.add_argument("--base-url", default="https://api.deepseek.com", help="API 地址")
    args = parser.parse_args()

    prompt = " ".join(args.prompt) if args.prompt else input("> ")
    api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("请设置 DEEPSEEK_API_KEY 环境变量")
        sys.exit(1)

    level = ThinkingLevel(args.level)
    config = build_thinking_config(level)

    print(f"\n🧠 当前模式: {level.label}")
    print(f"   reasoning_effort: {config.reasoning_effort}")
    print(f"   展示思考: {config.display.show_think_block}")
    print(f"   展示 MOOD: {config.display.show_mood}")
    print()

    client = OpenAI(base_url=args.base_url, api_key=api_key)

    system_prompt = build_full_system_prompt(level)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    if args.stream:
        params = build_api_params(level, messages, args.model)
        response = client.chat.completions.create(**params, stream=True)
        handle_stream(response, config.display)
    else:
        params = build_api_params(level, messages, args.model)
        response = client.chat.completions.create(**params)
        handle_non_stream(response, config.display)


if __name__ == "__main__":
    main()
