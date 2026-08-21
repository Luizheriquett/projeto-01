# ChatPatty

Chat de voz em tempo real com compartilhamento de tela, via WebRTC real
(peer-to-peer) + sinalização em Socket.IO. Sem cadastro: cria-se uma sala,
compartilha-se o link, entra-se com nome e avatar.

## O que é real aqui

- **Áudio e vídeo trafegam direto entre os navegadores** (WebRTC), o
  servidor só troca as mensagens de "apresentação" (offer/answer/ICE).
- Microfone com cancelamento de eco, supressão de ruído e ganho automático
  reais (constraints nativas do `getUserMedia`).
- Detecção de voz (VAD) real, rodando no seu próprio áudio via Web Audio API.
- Compartilhamento de tela real via `getDisplayMedia`, com pedido de até
  2560×1440 @ 60fps e adaptação automática de bitrate/resolução com base em
  perda de pacotes e RTT medidos via `RTCPeerConnection.getStats()`.
- Volume individual por participante (Web Audio `GainNode`) e seleção de
  dispositivo de saída (`setSinkId`, onde o navegador suportar).
- Reconexão automática do Socket.IO e tentativa de ICE restart quando uma
  conexão WebRTC cai.

## O que depende do SEU deploy (não é código, é infraestrutura)

1. **HTTPS obrigatório.** Fora de `localhost`, todo navegador bloqueia
   câmera/mic/tela sem contexto seguro. Rode atrás de um proxy com TLS
   (nginx + Let's Encrypt, Caddy, Cloudflare, ou a própria plataforma de
   deploy).
2. **TURN server.** Os STUN públicos incluídos resolvem boa parte dos casos,
   mas **não atravessam NAT simétrico nem várias redes corporativas/4G**.
   Para garantir conexão em qualquer rede, suba um TURN (ex: [coturn](https://github.com/coturn/coturn))
   ou use um serviço gerenciado (Twilio Network Traversal, Cloudflare Calls,
   Metered, Xirsys) e preencha as variáveis `TURN_URL`, `TURN_USERNAME`,
   `TURN_CREDENTIAL`.
3. **Teste real multi-rede/multi-navegador/multi-dispositivo.** Eu revisei a
   lógica e testei o servidor e as rotas aqui, mas não tenho como abrir
   Chrome + Firefox + Safari + Android reais em redes diferentes ao mesmo
   tempo neste ambiente. Use o checklist no fim deste arquivo antes de
   considerar "pronto para produção".

## Rodando localmente

```bash
cd backend
npm install
npm start
# abre em http://localhost:3001
```

Em `localhost` o Chrome/Firefox liberam mic/câmera/tela mesmo sem HTTPS —
ótimo para testar em duas abas do mesmo computador.

## Variáveis de ambiente

Crie um `.env` (ou configure na sua plataforma de deploy):

```env
PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=https://seu-dominio.com
MAX_USERS_PER_ROOM=12

# TURN (opcional, mas recomendado para produção)
TURN_URL=turn:seu-turn.com:3478,turns:seu-turn.com:5349
TURN_USERNAME=usuario
TURN_CREDENTIAL=senha
```

## Deploy sugerido

Qualquer host Node.js funciona (Railway, Render, Fly.io, um VPS com PM2).
Passos gerais para um VPS:

```bash
git clone <seu-repo>
cd chatpatty/backend
npm install --production
npm install -g pm2
pm2 start server.js --name chatpatty
pm2 save
```

Na frente, um nginx com TLS fazendo proxy para a porta 3001, com suporte a
WebSocket (`Upgrade`/`Connection` headers) para o Socket.IO funcionar.

### TURN com coturn (exemplo mínimo)

```bash
sudo apt install coturn
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=seu-dominio.com
user=usuario:senha
cert=/etc/letsencrypt/live/seu-dominio.com/fullchain.pem
pkey=/etc/letsencrypt/live/seu-dominio.com/privkey.pem
```

## Arquitetura

```
backend/
  server.js          -> Express + Socket.IO: salas, presença, sinalização
  public/
    index.html        -> landing + sala (SPA leve, sem framework)
    css/styles.css     -> tema visual (desktop + mobile)
    js/
      app.js            -> orquestração geral
      webrtc-manager.js -> malha WebRTC (1 RTCPeerConnection por par, negociação perfeita)
      media-manager.js  -> microfone, tela, dispositivos, pipeline de áudio remoto
      audio-vad.js       -> detecção de voz local
      socket-client.js   -> wrapper sobre Socket.IO
      ui.js               -> renderização de participantes/palco/toasts
      emitter.js          -> event emitter leve
```

Topologia: **malha peer-to-peer (mesh)**. Cada participante mantém uma
conexão direta com cada outro. É a abordagem certa para salas pequenas
(o código limita a 12 pessoas por sala via `MAX_USERS_PER_ROOM`); para salas
muito maiores, a arquitetura correta migraria para um SFU (ex: mediasoup,
LiveKit) — fora do escopo pedido aqui, mas vale saber a diferença se a sala
crescer.

## Checklist de testes antes de considerar pronto

- [ ] 2 usuários na mesma rede
- [ ] 3+ usuários, em redes diferentes (uma delas 4G)
- [ ] Entrada e saída da sala repetidas vezes
- [ ] Mic ligado/desligado, indicador de "falando" reagindo
- [ ] Troca de microfone e de saída de áudio em uma chamada em andamento
- [ ] Compartilhamento de tela em 720p/1080p/1440p, 30 e 60fps
- [ ] Parar o compartilhamento pelo botão nativo do navegador ("Parar
      compartilhamento") e ver se a UI reage corretamente
- [ ] Celular (Android/iOS): orientação retrato/paisagem, painel de
      participantes deslizante, controles grandes
- [ ] Rede instável: desligar/religar Wi-Fi e ver a reconexão automática
- [ ] Chrome, Firefox, Safari, Edge
- [ ] Tela cheia no compartilhamento

Sem TURN configurado, o teste "redes diferentes" é o que mais tende a falhar
— é esperado, é exatamente o problema que o TURN resolve.
