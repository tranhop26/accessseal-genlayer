import { publicConfigMarker } from "@/lib/config";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(publicConfigMarker(process.env), {
    headers: {
      "cache-control": "public, max-age=0, s-maxage=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
