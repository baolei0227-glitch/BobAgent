"""
thinking_level.py — 可嵌入任意 Agent 的思考深度控制模块

支持 5 档：off / low / medium / high / max
每个档位控制三件事：
  1. API 的 reasoning_effort 参数
  2. 系统提示注入的思考指令强度
  3. 前端展示策略

用法：
  from thinking_level import ThinkingLevel, build_system_prompt_injection, get_reasoning_effort

  level = ThinkingLevel.MEDIUM
  effort = get_reasoning_effort(level)         # → "medium"
  injection = build_system_prompt_injection(level)  # → 系统提示追加文本
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Optional


class ThinkingLevel(str, Enum):
    OFF = "off"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    MAX = "max"

    @property
    def label(self) -> str:
        return {
            self.OFF: "不推理",
            self.LOW: "轻推理",
            self.MEDIUM: "平衡推理",
            self.HIGH: "深度推理",
            self.MAX: "极致推理",
        }[self]


# ---- 第一层：reasoning_effort 参数 ----

REASONING_EFFORT_MAP = {
    ThinkingLevel.OFF: None,       # 不传参数，模型跳过推理
    ThinkingLevel.LOW: "low",
    ThinkingLevel.MEDIUM: "medium",
    ThinkingLevel.HIGH: "high",
    ThinkingLevel.MAX: "high",     # max 也用 high，配合其他机制推到极限
}


def get_reasoning_effort(level: ThinkingLevel) -> Optional[str]:
    """返回传给 API 的 reasoning_effort 参数值。off 时返回 None。"""
    return REASONING_EFFORT_MAP[level]


# ---- 第二层：系统提示注入 ----

# off: 不注入任何思考指令
# low: 简单思考提示
# medium: 带 MOOD 的中等思考
# high: 深度思考 + 结构化解题框架
# max: 极致推理 + 强制结构化分析

SYSTEM_PROMPT_INJECTIONS = {
    ThinkingLevel.OFF: "",

    ThinkingLevel.LOW: """
## 思考要求

在回答前进行简要思考，但不要过度分析。思考过程用 <think></think> 标签包裹。
""",

    ThinkingLevel.MEDIUM: """
## 思考要求

每轮回答前先进行充分的思考，用 <think></think> 标签包裹。

思考内容应包括：
- 对用户问题的理解和拆解
- 需要确认的前提条件
- 推理的关键步骤

## MOOD

每轮回答前，输出一个 <mood> 块，捕捉当前的情绪和想法。包含四个维度：
- Vibe：最直接的感受（一条）
- Sparks：联想和灵感（三条）
- Reflections：反思和质疑（三条）
- Will：想做的事（两条）

MOOD 用 <mood></mood> 标签包裹，在 <think> 之前输出。
""",

    ThinkingLevel.HIGH: """
## 深度思考要求

对于每一个问题，请进行深度、结构化的思考。思考过程用 <think></think> 标签包裹。

必须包含以下步骤：
1. 用自己的话复述问题，确认理解正确
2. 列出已知条件和未知信息
3. 识别真正的问题（用户问的和用户需要的可能不同）
4. 构建推理链条，逐步推导
5. 检查每一步的可靠性，标注不确定的地方
6. 考虑多种可能的答案或方案，比较优劣

思考深度应足够：如果一个问题有隐含的前提假设，必须挖出来审视；如果有多种解法，必须全部列出并对比。

## MOOD

每轮回答前输出 <mood> 块，要求同上。
""",

    ThinkingLevel.MAX: """
## 极致推理要求

本模式下，你必须投入全部推理能力。思考过程用 <think></think> 标签包裹。

强制执行的推理框架：

### Phase 1: 理解
- 用自己的话完整复述问题
- 标记所有不确定的信息和假设
- 识别问题的隐含前提和边界条件

### Phase 2: 拆解
- 将问题拆解为 2~5 个子问题
- 理清子问题之间的依赖关系
- 确定哪些可以并行思考，哪些必须串行

### Phase 3: 深度推理
- 对每个子问题，从第一性原理出发逐步推导
- 列举所有合理的替代方案或解释
- 对每种方案进行优劣比较
- 标注推理中的薄弱环节

### Phase 4: 整合
- 检查子问题之间的衔接是否自洽
- 回溯到原始问题，确认是否完整回答
- 标注遗留的未解决问题

### Phase 5: 验证
- 如果可能，用另一种方式验证结论
- 设定检验标准：什么情况下你的答案会被证明是错的？

思考不设上限。宁可多想一步，不可遗漏关键。所有分析用 <think> 标签包裹。

## MOOD

每轮回答前输出 <mood> 块，要求同上。
""",
}


def build_system_prompt_injection(level: ThinkingLevel) -> str:
    """返回应该追加到系统提示末尾的思考指令。"""
    return SYSTEM_PROMPT_INJECTIONS[level]


# ---- 第三层：前端展示策略 ----

@dataclass
class ThinkingDisplayConfig:
    """前端如何展示思考过程的配置。"""
    show_think_block: bool = True      # 是否展示 <think> 内容
    think_collapsed: bool = False      # 是否默认折叠
    think_dimmed: bool = True          # 是否灰色显示
    show_mood: bool = True             # 是否展示 MOOD 块
    mood_collapsed: bool = False       # 是否默认折叠


DISPLAY_CONFIGS = {
    ThinkingLevel.OFF: ThinkingDisplayConfig(
        show_think_block=False,
        show_mood=False,
    ),
    ThinkingLevel.LOW: ThinkingDisplayConfig(
        think_collapsed=True,
        show_mood=False,
    ),
    ThinkingLevel.MEDIUM: ThinkingDisplayConfig(),
    ThinkingLevel.HIGH: ThinkingDisplayConfig(),
    ThinkingLevel.MAX: ThinkingDisplayConfig(
        think_collapsed=False,  # 极致模式下默认展开思考
    ),
}


def get_display_config(level: ThinkingLevel) -> ThinkingDisplayConfig:
    """返回前端展示配置。"""
    return DISPLAY_CONFIGS[level]


# ---- 综合构建函数 ----

@dataclass
class ThinkingConfig:
    """一个完整的思考深度配置。"""
    level: ThinkingLevel
    reasoning_effort: Optional[str]
    system_prompt_injection: str
    display: ThinkingDisplayConfig


def build_thinking_config(level: ThinkingLevel) -> ThinkingConfig:
    """一站式构建：给定级别，返回完整配置。"""
    return ThinkingConfig(
        level=level,
        reasoning_effort=get_reasoning_effort(level),
        system_prompt_injection=build_system_prompt_injection(level),
        display=get_display_config(level),
    )
