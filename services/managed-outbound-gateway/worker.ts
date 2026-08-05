import {
  handleManagedOutboundRequest,
  OutboundRequestStateDurableObject,
  type ManagedOutboundGatewayEnvironment,
} from "./gateway.ts";

export { OutboundRequestStateDurableObject };

const worker = {
  fetch(
    request: Request,
    env: ManagedOutboundGatewayEnvironment,
  ): Promise<Response> {
    return handleManagedOutboundRequest(request, env);
  },
};

export default worker;
