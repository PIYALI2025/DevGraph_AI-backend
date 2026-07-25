import { NextRequest, NextResponse } from "next/server";
import {
  executeQuery,
  getNodeWithRelationships,
  getUpstreamDependents,
  getCommitsForService,
} from "@/lib/graph-service";

/**
 * POST /api/graph
 *
 * actions:
 *   query      — run arbitrary Cypher: { action, cypher }
 *   node       — fetch node + relationships: { action, nodeId }
 *   dependents — upstream impact analysis: { action, signature, depth? }
 *   commits    — recent commits for a service: { action, serviceName }
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;

  try {
    switch (action) {
      case "query": {
        if (!body.cypher)
          return NextResponse.json({ error: "cypher is required" }, { status: 400 });
        return NextResponse.json({ results: await executeQuery(body.cypher) });
      }
      case "node": {
        if (!body.nodeId)
          return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
        return NextResponse.json({ node: await getNodeWithRelationships(body.nodeId) });
      }
      case "dependents": {
        if (!body.signature)
          return NextResponse.json({ error: "signature is required" }, { status: 400 });
        return NextResponse.json({ dependents: await getUpstreamDependents(body.signature, body.depth ?? 5) });
      }
      case "commits": {
        if (!body.serviceName)
          return NextResponse.json({ error: "serviceName is required" }, { status: 400 });
        return NextResponse.json({ commits: await getCommitsForService(body.serviceName) });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
