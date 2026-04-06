FROM node:20-alpine
WORKDIR /app

# Install dependencies (includes devDeps so tsx is available)
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Build the React frontend
RUN npm run build

# Tell the server it's in production (serves dist/, skips Vite dev server)
ENV NODE_ENV=production

EXPOSE 5001

# Run the TypeScript server via tsx
CMD ["npx", "tsx", "server.ts"]
