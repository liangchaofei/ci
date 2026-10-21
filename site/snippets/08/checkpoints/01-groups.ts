import { groupExchanges } from "../runtime/context-exchanges.ts";
import { createContextFixture } from "./context-fixture.ts";

const state = createContextFixture();
const groups = groupExchanges(state.messages.slice(1));
console.log(`原历史消息数（stateMessages）: ${state.messages.length}`);
console.log(`完整组大小（groups）: ${groups.map((group) => group.length).join(" -> ")}`);
