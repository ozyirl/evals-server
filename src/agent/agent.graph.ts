import { AIMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';

function shouldContinue(state: typeof MessagesAnnotation.State) {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  if (lastMessage.tool_calls?.length) {
    return 'tools';
  }
  return END;
}

export function buildAgentGraph(
  model: ChatOpenAI,
  tools: StructuredToolInterface[],
) {
  const modelWithTools = model.bindTools(tools);
  const toolNode = new ToolNode(tools);

  async function callModel(state: typeof MessagesAnnotation.State) {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  const workflow = new StateGraph(MessagesAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent');

  return workflow.compile();
}
