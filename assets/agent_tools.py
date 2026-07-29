"""
agent_tools.py — Agent 工具系统

给 Agent 添加「动手能力」。与 thinking_level.py 和 skill_core 兼容。

核心概念：
  工具 = 一个 Python 函数 + API 格式的 schema 描述
  Agent 在思考后决定调用哪些工具，平台执行后把结果返回给 Agent 继续思考。

流程：
  用户输入 → [思考] → [调用工具1, 工具2] → [执行] → [思考] → [调用工具3] → ... → 最终回答

用法：
  from agent_tools import Tool, ToolRegistry, ToolExecutor, ToolCallLoop

  # 定义工具
  def read_file(path: str) -> str: ...

  registry = ToolRegistry()
  registry.register(Tool.from_function(read_file))

  # 执行循环
  loop = ToolCallLoop(client, model, registry)
  loop.run(user_input)
"""

import json
import inspect
import time
from dataclasses import dataclass, field
from typing import Optional, Callable, Any, Union, get_origin, get_args
from enum import Enum


# ============================================================
# 工具定义
# ============================================================

@dataclass
class Tool:
    """
    一个工具 = API 描述 + 可执行函数。

    API 描述遵循 OpenAI function calling 格式：
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "读取文件内容",
          "parameters": { ... JSON Schema ... }
        }
      }
    """

    name: str
    description: str
    parameters: dict          # JSON Schema
    func: Callable            # 实际执行的 Python 函数
    category: str = "general" # 工具分类（用于展示）

    def to_api_format(self) -> dict:
        """生成 OpenAI 兼容的工具描述。"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    @classmethod
    def from_function(
        cls,
        func: Callable,
        name: Optional[str] = None,
        description: Optional[str] = None,
        category: str = "general",
    ) -> "Tool":
        """
        从 Python 函数自动生成工具定义。

        使用函数的 docstring 作为 description，
        使用类型注解生成 parameters schema。

        Example:
            def add(a: int, b: int) -> int:
                '''两个数相加。'''
                return a + b

            tool = Tool.from_function(add)
        """
        import re

        func_name = name or func.__name__
        func_desc = description or (func.__doc__ or "").strip()

        # 从类型注解生成 JSON Schema
        sig = inspect.signature(func)
        properties = {}
        required = []

        for param_name, param in sig.parameters.items():
            if param_name in ("self", "cls"):
                continue

            param_type = param.annotation
            json_type = _python_type_to_json(param_type)

            # 尝试从 docstring 提取参数说明
            param_desc = _extract_param_desc(func.__doc__, param_name)

            properties[param_name] = {
                "type": json_type,
                "description": param_desc,
            }

            # 无默认值的参数标记为 required
            if param.default is inspect.Parameter.empty:
                required.append(param_name)

        parameters = {
            "type": "object",
            "properties": properties,
        }
        if required:
            parameters["required"] = required

        return cls(
            name=func_name,
            description=func_desc,
            parameters=parameters,
            func=func,
            category=category,
        )

    def execute(self, **kwargs) -> str:
        """执行工具，返回结果的字符串表示。"""
        try:
            result = self.func(**kwargs)
            if isinstance(result, str):
                return result
            return json.dumps(result, ensure_ascii=False, default=str)
        except Exception as e:
            return f"工具执行出错: {e}"


# ---- 辅助函数 ----

def _python_type_to_json(py_type) -> str:
    """Python 类型 → JSON Schema 类型。"""
    if py_type is inspect.Parameter.empty:
        return "string"
    if py_type is str:
        return "string"
    if py_type in (int, float):
        return "number"
    if py_type is bool:
        return "boolean"
    if py_type is list:
        return "array"
    if py_type is dict:
        return "object"

    # 处理 Optional[T] / Union[T, None] / T | None
    origin = get_origin(py_type)
    if origin is Union:
        args = [a for a in get_args(py_type) if a is not type(None)]
        if len(args) == 1:
            return _python_type_to_json(args[0])
    return "string"


def _extract_param_desc(docstring: Optional[str], param_name: str) -> str:
    """从 docstring 中提取参数说明。"""
    if not docstring:
        return ""
    import re
    pattern = rf'{param_name}\s*[:：]\s*(.+?)(?:\n|$)'
    match = re.search(pattern, docstring)
    return match.group(1).strip() if match else ""


# ============================================================
# 工具注册表
# ============================================================

class ToolRegistry:
    """
    工具注册表。管理 agent 可用的所有工具。

    提供按分类查询、按名称查找、批量转换 API 格式等功能。
    """

    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool):
        self._tools[tool.name] = tool

    def register_all(self, tools: list[Tool]):
        for t in tools:
            self.register(t)

    def unregister(self, name: str):
        self._tools.pop(name, None)

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def list_all(self) -> list[Tool]:
        return list(self._tools.values())

    def to_api_format(self) -> list[dict]:
        """转换为 OpenAI API 需要的工具列表。"""
        return [t.to_api_format() for t in self._tools.values()]

    def by_category(self, category: str) -> list[Tool]:
        return [t for t in self._tools.values() if t.category == category]

    def count(self) -> int:
        return len(self._tools)


# ============================================================
# 工具使用追踪
# ============================================================

@dataclass
class ToolCallRecord:
    """单次工具调用记录。"""
    tool_name: str
    arguments: dict
    result: str
    duration_ms: float
    success: bool = True


class ToolUsageTracker:
    """
    工具使用追踪器。

    记录本轮对话中每次工具调用，用于：
      1. 思考块底部的 "🔧 N 个工具" 展示
      2. 调试和日志
    """

    def __init__(self):
        self.records: list[ToolCallRecord] = []
        self._phase_records: dict[str, list[ToolCallRecord]] = {}

    def record(self, tool_name: str, arguments: dict, result: str, duration_ms: float):
        success = not result.startswith("工具执行出错:")
        rec = ToolCallRecord(
            tool_name=tool_name,
            arguments=arguments,
            result=result[:500],  # 截断太长结果
            duration_ms=duration_ms,
            success=success,
        )
        self.records.append(rec)

    def start_phase(self, phase: str):
        """标记一个新思考阶段。"""
        self._phase_records[phase] = []

    def record_in_phase(self, phase: str, tool_name: str, arguments: dict,
                        result: str, duration_ms: float):
        self.record(tool_name, arguments, result, duration_ms)
        if phase in self._phase_records:
            self._phase_records[phase].append(self.records[-1])

    @property
    def total_calls(self) -> int:
        return len(self.records)

    @property
    def tool_names(self) -> list[str]:
        return [r.tool_name for r in self.records]

    @property
    def summary(self) -> str:
        """生成 "🔧 N 个工具: tool1, tool2, ..." 的摘要。"""
        if not self.records:
            return ""
        names = ", ".join(dict.fromkeys(self.tool_names))  # 保序去重
        return f"🔧 {self.total_calls} 个工具: {names}"

    def clear(self):
        self.records.clear()
        self._phase_records.clear()


# ============================================================
# 工具调用循环
# ============================================================

class ToolCallLoop:
    """
    工具调用循环引擎。

    这是 Agent 「动手能力」的核心：管理 think → call → execute → think 的循环。

    Parameters:
        client: OpenAI 兼容客户端
        model: 模型 ID
        registry: 工具注册表
        max_rounds: 最大工具调用轮次（防止无限循环），默认 10
        tracker: 工具使用追踪器（不传则自动创建）
    """

    def __init__(
        self,
        client,
        model: str,
        registry: ToolRegistry,
        max_rounds: int = 10,
        tracker: Optional[ToolUsageTracker] = None,
        reasoning_effort: Optional[str] = None,
    ):
        self.client = client
        self.model = model
        self.registry = registry
        self.max_rounds = max_rounds
        self.tracker = tracker or ToolUsageTracker()
        self.reasoning_effort = reasoning_effort

    def _create_kwargs(self, messages, tools, stream=False) -> dict:
        """构建 chat.completions.create 的参数。"""
        kwargs = {
            "model": self.model,
            "messages": messages,
            "stream": stream,
        }
        if tools:
            kwargs["tools"] = tools
        if self.reasoning_effort:
            kwargs["extra_body"] = {"reasoning_effort": self.reasoning_effort}
        return kwargs

    # ------------------------------------------------------------------
    # 非流式执行
    # ------------------------------------------------------------------

    def run(
        self,
        messages: list[dict],
        thinking_display_config=None,
    ) -> tuple[str, list[dict]]:
        """
        执行完整的工具调用循环（非流式）。

        Args:
            messages: 初始消息列表（系统提示 + 用户输入）
            thinking_display_config: ThinkingDisplayConfig 或 None

        Returns:
            (final_response, all_messages)
            all_messages 包含完整的对话历史（含工具调用轮次）
        """
        self.tracker.clear()
        all_messages = list(messages)  # 复制，便于追加

        tools = self.registry.to_api_format()

        for round_idx in range(self.max_rounds):
            # 调用 API
            response = self.client.chat.completions.create(
                **self._create_kwargs(all_messages, tools, stream=False)
            )
            choice = response.choices[0]

            # 如果模型直接给出了文本回复（无工具调用）
            if choice.finish_reason == "stop" and choice.message.content:
                return (choice.message.content, all_messages)

            # 如果模型请求调用工具
            tool_calls = getattr(choice.message, "tool_calls", None)
            if not tool_calls:
                # 没有工具调用也没有文本 —— 异常情况
                return (choice.message.content or "", all_messages)

            # 把模型的 tool_calls 消息加入历史
            assistant_msg = {
                "role": "assistant",
                "content": choice.message.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            }
            all_messages.append(assistant_msg)

            # 执行每个工具调用
            for tc in tool_calls:
                tool_name = tc.function.name
                arguments = json.loads(tc.function.arguments)

                tool = self.registry.get(tool_name)
                if tool is None:
                    result = f"未知工具: {tool_name}"
                    duration = 0
                else:
                    start = time.time()
                    result = tool.execute(**arguments)
                    duration = (time.time() - start) * 1000

                # 记录
                self.tracker.record_in_phase(
                    f"round-{round_idx}",
                    tool_name, arguments, result, duration,
                )

                # 工具结果加入历史
                all_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })

        # 达到最大轮次上限，强制让模型总结
        all_messages.append({
            "role": "user",
            "content": "请基于以上工具调用结果，给出最终回答。",
        })
        response = self.client.chat.completions.create(
            **self._create_kwargs(all_messages, None, stream=False)
        )
        return (response.choices[0].message.content, all_messages)

    # ------------------------------------------------------------------
    # 流式执行
    # ------------------------------------------------------------------

    def run_stream(
        self,
        messages: list[dict],
        on_text: Callable[[str], None] = None,
        on_tool_call: Callable[[str, dict], None] = None,
        on_tool_result: Callable[[str, str, float], None] = None,
        is_cancelled: Callable[[], bool] = None,
    ) -> tuple[str, list[dict]]:
        """
        执行完整的工具调用循环（流式）。

        Args:
            messages: 初始消息列表
            on_text: 收到文本片段时的回调
            on_tool_call: 工具被调用时的回调 (tool_name, arguments)
            on_tool_result: 工具执行完成的回调 (tool_name, result, duration_ms)
            is_cancelled: 返回 True 时中断流式调用

        Returns:
            (final_response, all_messages)
        """
        self.tracker.clear()
        all_messages = list(messages)
        tools = self.registry.to_api_format()

        def _cancelled():
            return bool(is_cancelled and is_cancelled())

        for round_idx in range(self.max_rounds):
            if _cancelled():
                return ("", all_messages)

            # 流式调用
            stream = self.client.chat.completions.create(
                **self._create_kwargs(all_messages, tools, stream=True)
            )

            # 收集流式内容
            content_parts = []
            tool_call_buf: dict[int, dict] = {}  # index -> {id, name, args}

            for chunk in stream:
                if _cancelled():
                    stream.close()
                    return ("", all_messages)
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta is None:
                    continue

                # 文本内容
                if delta.content:
                    content_parts.append(delta.content)
                    if on_text:
                        on_text(delta.content)

                # 工具调用
                if delta.tool_calls:
                    for tc_delta in delta.tool_calls:
                        idx = tc_delta.index
                        if idx not in tool_call_buf:
                            tool_call_buf[idx] = {
                                "id": tc_delta.id or "",
                                "name": "",
                                "arguments": "",
                            }
                        buf = tool_call_buf[idx]
                        if tc_delta.id:
                            buf["id"] = tc_delta.id
                        if tc_delta.function:
                            if tc_delta.function.name:
                                buf["name"] += tc_delta.function.name
                            if tc_delta.function.arguments:
                                buf["arguments"] += tc_delta.function.arguments

            # 检查是否有工具调用
            if not tool_call_buf:
                final_text = "".join(content_parts)
                return (final_text, all_messages)

            # 构建 assistant 消息
            parsed_tool_calls = []
            for idx in sorted(tool_call_buf.keys()):
                buf = tool_call_buf[idx]
                parsed_tool_calls.append({
                    "id": buf["id"],
                    "type": "function",
                    "function": {
                        "name": buf["name"],
                        "arguments": buf["arguments"],
                    },
                })

            assistant_msg = {
                "role": "assistant",
                "content": "".join(content_parts) or None,
                "tool_calls": parsed_tool_calls,
            }
            all_messages.append(assistant_msg)

            # 执行工具
            for tc in parsed_tool_calls:
                tool_name = tc["function"]["name"]
                try:
                    arguments = json.loads(tc["function"]["arguments"])
                except json.JSONDecodeError:
                    arguments = {}

                if on_tool_call:
                    on_tool_call(tool_name, arguments)

                tool = self.registry.get(tool_name)
                if tool is None:
                    result = f"未知工具: {tool_name}"
                    duration = 0
                else:
                    start = time.time()
                    result = tool.execute(**arguments)
                    duration = (time.time() - start) * 1000

                self.tracker.record_in_phase(
                    f"round-{round_idx}",
                    tool_name, arguments, result, duration,
                )

                if on_tool_result:
                    on_tool_result(tool_name, result, duration)

                all_messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                })

        # 达到上限
        all_messages.append({
            "role": "user",
            "content": "请基于以上工具调用结果，给出最终回答。",
        })
        final_text = ""
        stream = self.client.chat.completions.create(
            **self._create_kwargs(all_messages, None, stream=True)
        )
        for chunk in stream:
            if _cancelled():
                stream.close()
                return (final_text, all_messages)
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                final_text += delta.content
                if on_text:
                    on_text(delta.content)
        return (final_text, all_messages)
