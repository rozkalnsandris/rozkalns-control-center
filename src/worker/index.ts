import { buildHealthPayload } from "../shared/health";

const worker: ExportedHandler<Env> = {
  fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json(buildHealthPayload());
    }

    return new Response("Not Found", { status: 404 });
  }
};

export default worker;
