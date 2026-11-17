"""The lab's sample graph `agent` (TSK-84): a fake chat model (no network), a tool node, a
conditional edge, a subgraph, an `interrupt()` for approval and store writes."""

import operator
import re
from typing import Annotated, TypedDict

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AnyMessage, ToolMessage
from langgraph.config import get_store
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt


class State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    approved: bool
    steps: Annotated[list[str], operator.add]


def plan(state: State) -> dict:
    """Answers arithmetic with a tool call, anything else directly (a fake model: no network)."""
    last = state["messages"][-1].content if state["messages"] else ""
    numbers = re.findall(r"\d+", str(last))
    if len(numbers) >= 2 and not any(isinstance(m, ToolMessage) for m in state["messages"]):
        reply = AIMessage(content="", tool_calls=[{"name": "multiply", "args": {"a": int(numbers[0]), "b": int(numbers[1])}, "id": "call-1"}])
    else:
        model = GenericFakeChatModel(messages=iter([AIMessage(content=f"Here is what I found: {last}")]))
        reply = model.invoke(state["messages"])
    return {"messages": [reply], "steps": ["plan"]}


def route(state: State) -> str:
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else "approve"


def tools(state: State) -> dict:
    call = state["messages"][-1].tool_calls[0]
    result = call["args"]["a"] * call["args"]["b"]
    return {"messages": [ToolMessage(content=str(result), tool_call_id=call["id"])], "steps": ["tools"]}


def approve(state: State) -> dict:
    answer = interrupt({"question": "Send this answer?", "answer": str(state["messages"][-1].content)})
    return {"approved": answer == "approved", "steps": ["approve"]}


def remember(state: State) -> dict:
    get_store().put(("lab", "answers"), f"answer-{len(state['messages'])}", {"text": str(state["messages"][-1].content), "approved": state.get("approved", False)})
    return {"steps": ["remember"]}


def format_answer(state: State) -> dict:
    return {"messages": [AIMessage(content=f"Final: {state['messages'][-1].content}")], "steps": ["format"]}


summary = StateGraph(State)
summary.add_node("remember", remember)
summary.add_node("format", format_answer)
summary.add_edge(START, "remember")
summary.add_edge("remember", "format")
summary.add_edge("format", END)

builder = StateGraph(State)
builder.add_node("plan", plan)
builder.add_node("tools", tools)
builder.add_node("approve", approve)
builder.add_node("summarize", summary.compile())
builder.add_edge(START, "plan")
builder.add_conditional_edges("plan", route, {"tools": "tools", "approve": "approve"})
builder.add_edge("tools", "plan")
builder.add_edge("approve", "summarize")
builder.add_edge("summarize", END)
graph = builder.compile()
