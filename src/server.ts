import express, { Request, Response } from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const FACEIT_KEY = process.env.FACEIT_KEY || "";
const DEBUG_FACEIT = process.env.DEBUG_FACEIT === "true";

type GameData = {
  name?: string;
  game_id?: string;
  slug?: string;
  skill_level?: number;
  faceit_elo?: number;
  [key: string]: any;
};

type CacheEntry = {
  value: any;
  expire: number;
};

const cache = new Map<string, CacheEntry>();
function setCache(key: string, value: any, ttl = 30_000) {
  cache.set(key, { value, expire: Date.now() + ttl });
}
function getCache(key: string) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expire) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

app.get("/faceit/:nick", async (req: Request, res: Response) => {
  const nick = req.params.nick;
  const game = (req.query.game as string)?.toLowerCase() || "cs2";
  const fmt = (req.query.format as string)?.toLowerCase() || "json";

  const cacheKey = `faceit:${nick}:${game}`;
  const cached = getCache(cacheKey);

  if (cached) {
    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.status(200).send(cached.text);
    } else {
      res.json(cached.json);
    }

    (async () => {
      try {
        await atualizarCache(nick, game);
      } catch {}
    })();

    return;
  }

  try {
    const data = await atualizarCache(nick, game);
    const result = data.json;
    const text = data.text;

    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(text);
    }
    return res.json(result);
  } catch (err: any) {
    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res
        .status(200)
        .send(`Erro ou timeout ao buscar ELO para ${nick}.`);
    }
    return res.status(500).json({ error: "Erro ao buscar ELO" });
  }
});

async function atualizarCache(nick: string, game: string) {
  const apiUrl = "https://open.faceit.com/data/v4/players";
  const response = await axios.get(apiUrl, {
    params: { nickname: nick, game },
    headers: { Authorization: `Bearer ${FACEIT_KEY}` },
    timeout: 1500,
  });

  const data = response.data;
  const gameLower = game.toLowerCase();
  const g = data.games?.[gameLower];

  const elo = g?.faceit_elo ?? data.faceit_elo ?? null;
  const level = g?.skill_level ?? data.skill_level ?? null;

  const result = {
    nickname: data.nickname || nick,
    game,
    level: level ? String(level) : null,
    elo: elo ?? null,
    retrieved_at: new Date().toISOString(),
  };

  const text =
    result.elo && result.level
      ? `${result.nickname} — ELO: ${result.elo} | Level: ${result.level}`
      : result.level
      ? `${result.nickname} — Level: ${result.level} (ELO não disponível)`
      : `Perfil ${nick} não encontrado ou sem dados para ${game}.`;

  setCache(`faceit:${nick}:${game}`, { json: result, text }, 60_000);
  return { json: result, text };
}

app.get("/elo/:nick", (req, res) => {
  const nick = req.params.nick;
  const cached = getCache(`faceit:${nick}:cs2`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send(cached ? cached.text : "Carregando dados...");
});


app.get("/_botrix-test", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`🚀 Faceit API rodando na porta ${PORT}`);
});
