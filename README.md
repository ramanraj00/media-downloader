# Media Downloader Bot

A God-tier media downloader platform built as a Telegram bot. This project uses a microservices architecture to handle downloading, processing, and delivering media from various platforms using the powerful [Cobalt](https://github.com/imputnet/cobalt) API.

## 🌟 Features

- **Telegram Bot Interface**: Easy to use interface via Telegram (built with `grammy`).
- **Wide Platform Support**: Powered by Cobalt, supporting downloads from YouTube, Twitter/X, Instagram, Reddit, TikTok, and more.
- **Microservices Architecture**: Highly scalable and decoupled services.
- **Robust Queueing**: Uses Redis for task queueing and communication between services.
- **Persistent Storage**: PostgreSQL for data persistence.

## 🏗️ Architecture

This project is structured as a monorepo using [TurboRepo](https://turbo.build/) containing multiple apps and services:

### Apps
- **`apps/api`**: REST API for internal communication and external interactions.
- **`apps/bot`**: The Telegram Bot application that interacts with users.

### Services
- **`services/relay`**: Manages task routing and relaying between different stages.
- **`services/downloader`**: Interfaces with the Cobalt API to download requested media.
- **`services/media-processor`**: Processes downloaded media (e.g., resizing, format conversion) if required.
- **`services/delivery`**: Handles sending the final processed media back to the user on Telegram.

### Packages (Shared)
- **`@media-downloader/config`**: Shared configuration.
- **`@media-downloader/core`**: Core business logic and shared utilities.
- **`@media-downloader/logger`**: Standardized logging setup.
- **`@media-downloader/types`**: Shared TypeScript types and interfaces.

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [Docker](https://www.docker.com/) and Docker Compose
- A Telegram Bot Token (Get one from [@BotFather](https://t.me/BotFather))

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd media-downloader
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   Copy the example environment file and fill in your Bot Token:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and set your `BOT_TOKEN`:
   ```env
   BOT_TOKEN=your_telegram_bot_token_here
   ```

4. **Build the project:**
   ```bash
   npm run build
   ```

5. **Start the services with Docker:**
   This will spin up Postgres, Redis, Cobalt, and all the microservices.
   ```bash
   docker-compose up -d
   ```

## 🛠️ Development

To run the project in development mode:

1. Start only the infrastructure (DB, Redis, Cobalt):
   ```bash
   docker-compose up -d postgres redis cobalt
   ```

2. Run the development script via TurboRepo:
   ```bash
   npm run dev
   ```

## 📝 Available Scripts

- `npm run build`: Build all apps and packages.
- `npm run dev`: Run all apps and services in watch mode for development.
- `npm run clean`: Clean up all `dist` folders and cache.
- `npm run lint`: Run ESLint across the project.
- `npm run test`: Run tests (if configured).

## 🐋 Docker Compose Services

- `postgres`: PostgreSQL database (port 5432)
- `redis`: Redis cache and message broker (port 6379)
- `cobalt`: Cobalt media downloader API (port 9000)
- `api`: Node.js REST API
- `bot`: Telegram Bot service
- `relay`: Task relay service
- `downloader`: Download worker
- `processor`: Media processing worker
- `delivery`: Media delivery worker

## 📄 License

This project is licensed under the MIT License.

