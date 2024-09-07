import {createHash} from "crypto";
import OpenAI from "openai";
import {Redis} from "@upstash/redis";
import {DataAPIClient} from "@datastax/astra-db-ts";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function embedding(prompt) {
  try {
    const response = await openai.embeddings.create({
      input: prompt,
      model: "text-embedding-3-small",
    });
    return response.data[0].embedding;
  } catch (e) {
    throw new Error("Failed to embed prompt");
  }
}

export const handler = async (event) => {
  const query = event.queryStringParameters?.query || undefined;
  const pubkey = event.queryStringParameters?.pubkey || undefined;

  if (!query || !pubkey) {
    return {
      statusCode: 400,
      body: "Missing required fields: query, pubkey",
    };
  }

  const hash = createHash("sha256")
    .update(`${pubkey}:search:${query}`)
    .digest("hex");

  const redis = Redis.fromEnv();

  const cache = await redis.get(hash);

  if (cache) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        data: cache,
        cached: true,
      }),
    };
  }

  const client = new DataAPIClient(process.env.ASTRADB_TOKEN || "");

  const db = client.db(process.env.ASTRADB_ENDPOINT || "");

  const similarPosts = await db
    .collection("events")
    .find(
      {pubkey: pubkey},
      {
        vector: await embedding(query),
        limit: 10,
        projection: {
          $vector: 0,
        },
      },
    )
    .toArray();

  await redis.set(hash, similarPosts, {
    ex: 5 * 60 * 60,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      data: similarPosts,
      cached: false,
    }),
  };
}