import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const assetsDir = path.resolve('assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

const images = [
  {
    filename: 'beans1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #112818 0%, #050d08 70%, #000000 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            color: #fff; overflow: hidden; position: relative;
          }
          .circle-glow {
            position: absolute; width: 380px; height: 380px;
            border-radius: 50%; border: 3px solid #10b981;
            box-shadow: 0 0 35px #10b981, inset 0 0 35px #10b981;
            animation: pulse 2s infinite alternate;
          }
          .grid {
            position: absolute; inset: 0;
            background-image: linear-gradient(rgba(16, 185, 129, 0.08) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(16, 185, 129, 0.08) 1px, transparent 1px);
            background-size: 32px 32px;
          }
          .bean-card {
            z-index: 2; text-align: center;
          }
          .bean-art {
            width: 220px; height: 220px; margin: 0 auto 16px;
            background: linear-gradient(135deg, #2e1a0d 0%, #522d14 50%, #170d06 100%);
            border-radius: 45% 55% 50% 50% / 60% 60% 40% 40%;
            border: 4px solid #10b981;
            box-shadow: 0 0 30px rgba(16, 185, 129, 0.6), inset 0 0 20px rgba(245, 158, 11, 0.4);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            position: relative;
          }
          .crease {
            width: 14px; height: 160px; background: #120904;
            border-radius: 50%; transform: rotate(15deg);
            box-shadow: 0 0 8px rgba(0,0,0,0.8);
          }
          .glasses {
            position: absolute; top: 70px;
            width: 160px; height: 36px;
            display: flex; gap: 8px; justify-content: center;
          }
          .lens {
            width: 65px; height: 32px; background: #000;
            border: 3px solid #f59e0b; border-radius: 4px;
            box-shadow: 0 0 10px #f59e0b;
          }
          .badge-pill {
            display: inline-block; padding: 6px 18px; border-radius: 20px;
            background: rgba(16, 185, 129, 0.2); border: 1px solid #10b981;
            font-size: 14px; font-weight: 700; letter-spacing: 2px;
            color: #34d399; text-transform: uppercase; margin-bottom: 8px;
            box-shadow: 0 0 12px rgba(16, 185, 129, 0.3);
          }
          h1 {
            font-size: 32px; font-weight: 900; letter-spacing: 3px;
            background: linear-gradient(to right, #10b981, #f59e0b);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 20px rgba(16, 185, 129, 0.4);
          }
          p { font-size: 13px; color: #94a3b8; letter-spacing: 1.5px; margin-top: 4px; }
        </style>
      </head>
      <body>
        <div class="grid"></div>
        <div class="circle-glow"></div>
        <div class="bean-card">
          <div class="badge-pill">0xBEANS ARCHITECTURE</div>
          <div class="bean-art">
            <div class="crease"></div>
            <div class="glasses"><div class="lens"></div><div class="lens"></div></div>
          </div>
          <h1>$BEANS RESERVE</h1>
          <p>THE ON-CHAIN CENTRAL BANK</p>
        </div>
      </body>
      </html>
    `
  },
  {
    filename: 'charter1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #181206 0%, #0c0802 70%, #000000 100%);
            display: flex; align-items: center; justify-content: center;
            font-family: Georgia, serif; color: #fef08a; overflow: hidden; position: relative;
          }
          .border-frame {
            position: absolute; inset: 24px;
            border: 3px double #d97706;
            box-shadow: 0 0 25px rgba(217, 119, 6, 0.5), inset 0 0 25px rgba(217, 119, 6, 0.3);
          }
          .inner-frame {
            position: absolute; inset: 34px;
            border: 1px dashed rgba(245, 158, 11, 0.4);
          }
          .content {
            z-index: 2; text-align: center; padding: 40px;
          }
          .seal {
            width: 140px; height: 140px; margin: 0 auto 20px;
            border-radius: 50%;
            background: radial-gradient(circle, #b45309 0%, #78350f 70%, #451a03 100%);
            border: 4px solid #fef08a;
            box-shadow: 0 0 30px #f59e0b;
            display: flex; align-items: center; justify-content: center;
            font-size: 54px; font-weight: bold; color: #fef08a;
          }
          h2 {
            font-size: 15px; letter-spacing: 5px; text-transform: uppercase;
            color: #d97706; margin-bottom: 8px; font-family: sans-serif; font-weight: bold;
          }
          h1 {
            font-size: 34px; letter-spacing: 2px;
            color: #fef3c7; text-shadow: 0 0 15px rgba(245, 158, 11, 0.6);
            margin-bottom: 12px;
          }
          .clause {
            font-size: 13px; line-height: 1.6; color: #d4d4d8; font-style: italic; max-width: 380px;
          }
        </style>
      </head>
      <body>
        <div class="border-frame"></div>
        <div class="inner-frame"></div>
        <div class="content">
          <h2>Standard Reserve Protocol</h2>
          <div class="seal">SR</div>
          <h1>BANKER CHARTER</h1>
          <p class="clause">"By sovereign immutable smart contract decree, the bearer is authorized to mint, redeem, and govern autonomous branch reserves on Robinhood Chain."</p>
        </div>
      </body>
      </html>
    `
  },
  {
    filename: 'vlad1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: linear-gradient(180deg, #180033 0%, #3b0764 50%, #030014 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: "Impact", "Arial Black", sans-serif; overflow: hidden; position: relative;
          }
          .sun {
            position: absolute; bottom: 140px; width: 260px; height: 260px;
            background: linear-gradient(180deg, #f43f5e 0%, #fbbf24 100%);
            border-radius: 50%; box-shadow: 0 0 50px #f43f5e;
          }
          .grid-floor {
            position: absolute; bottom: 0; width: 100%; height: 160px;
            background: linear-gradient(180deg, rgba(236, 72, 153, 0.3) 0%, transparent 100%);
            perspective: 200px;
          }
          .bow-icon {
            z-index: 2; width: 150px; height: 150px; margin-bottom: 20px;
            border-radius: 50%; background: rgba(0,0,0,0.6);
            border: 3px solid #10b981; box-shadow: 0 0 25px #10b981;
            display: flex; align-items: center; justify-content: center;
            font-size: 70px;
          }
          .text-container { z-index: 2; text-align: center; }
          h2 {
            font-size: 16px; letter-spacing: 4px; color: #a855f7;
            text-shadow: 0 0 10px #ec4899; margin-bottom: 6px;
          }
          h1 {
            font-size: 42px; letter-spacing: 2px;
            background: linear-gradient(180deg, #fff 0%, #38bdf8 100%);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 25px rgba(56, 189, 248, 0.8);
          }
          .tag {
            font-family: sans-serif; font-size: 13px; font-weight: bold;
            color: #34d399; letter-spacing: 2px; margin-top: 8px;
          }
        </style>
      </head>
      <body>
        <div class="sun"></div>
        <div class="grid-floor"></div>
        <div class="bow-icon">🏹</div>
        <div class="text-container">
          <h2>WHEN I WAS A BOY IN BULGARIA</h2>
          <h1>$VLAD TENEV</h1>
          <div class="tag">ROBINHOOD CHAIN ARCHITECT</div>
        </div>
      </body>
      </html>
    `
  },
  {
    filename: 'buybutton1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #062b16 0%, #03140a 60%, #000 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative;
          }
          .candles {
            position: absolute; bottom: 0; width: 100%; height: 200px;
            display: flex; justify-content: space-around; align-items: flex-end; padding: 0 40px; opacity: 0.35;
          }
          .candle { width: 22px; background: #22c55e; border-radius: 3px; box-shadow: 0 0 15px #22c55e; }
          .c1 { height: 70px; } .c2 { height: 110px; } .c3 { height: 140px; } .c4 { height: 190px; }
          .button-outer {
            z-index: 2; width: 250px; height: 250px; border-radius: 50%;
            background: radial-gradient(circle, #166534 0%, #052e16 80%);
            border: 6px solid #22c55e;
            box-shadow: 0 0 50px #22c55e, inset 0 0 40px #4ade80;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
          }
          .button-inner {
            width: 190px; height: 190px; border-radius: 50%;
            background: radial-gradient(circle, #4ade80 0%, #15803d 70%);
            box-shadow: 0 10px 25px rgba(0,0,0,0.6), inset 0 0 20px #86efac;
            display: flex; align-items: center; justify-content: center;
          }
          .buy-text {
            font-size: 64px; font-weight: 900; letter-spacing: 4px;
            color: #ffffff; text-shadow: 0 0 20px #052e16, 0 3px 6px #000;
          }
          .title {
            z-index: 2; margin-top: 24px; font-size: 26px; font-weight: 900;
            color: #4ade80; letter-spacing: 3px; text-shadow: 0 0 20px #22c55e;
          }
          .sub { z-index: 2; font-size: 13px; color: #86efac; letter-spacing: 2px; margin-top: 4px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="candles">
          <div class="candle c1"></div><div class="candle c2"></div><div class="candle c3"></div><div class="candle c4"></div>
        </div>
        <div class="button-outer">
          <div class="button-inner">
            <div class="buy-text">BUY</div>
          </div>
        </div>
        <div class="title">THE BUY BUTTON</div>
        <div class="sub">CAN NEVER BE TURNED OFF</div>
      </body>
      </html>
    `
  },
  {
    filename: 'wsbape1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #0f172a 0%, #020617 80%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .diamond-card {
            z-index: 2; width: 220px; height: 220px; border-radius: 50%;
            background: radial-gradient(circle, #38bdf8 0%, #0369a1 80%);
            border: 4px solid #7dd3fc; box-shadow: 0 0 45px #38bdf8;
            display: flex; align-items: center; justify-content: center;
            font-size: 96px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #38bdf8; margin-bottom: 6px; }
          h1 {
            font-size: 38px; font-weight: 900; letter-spacing: 2px;
            background: linear-gradient(to right, #38bdf8, #22c55e);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 25px rgba(56, 189, 248, 0.6);
          }
          p { font-size: 14px; color: #94a3b8; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="diamond-card">💎</div>
        <h2>WALL STREET BETS // RETAIL</h2>
        <h1>DIAMOND HANDS</h1>
        <p>APES NEVER SELL THE DIP</p>
      </body>
      </html>
    `
  },
  {
    filename: 'starship1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #1e1b4b 0%, #0f172a 60%, #020617 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .mars {
            position: absolute; top: -60px; right: -60px; width: 220px; height: 220px;
            background: radial-gradient(circle at 35% 35%, #f97316 0%, #9a3412 70%);
            border-radius: 50%; box-shadow: 0 0 40px #f97316;
          }
          .rocket-box {
            z-index: 2; width: 210px; height: 210px; border-radius: 50%;
            background: rgba(15, 23, 42, 0.85); border: 4px solid #6366f1;
            box-shadow: 0 0 35px #6366f1;
            display: flex; align-items: center; justify-content: center;
            font-size: 90px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #818cf8; margin-bottom: 6px; }
          h1 {
            font-size: 38px; font-weight: 900; letter-spacing: 2px;
            background: linear-gradient(to right, #e0e7ff, #818cf8);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 25px rgba(99, 102, 241, 0.6);
          }
          p { font-size: 13px; color: #fb923c; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="mars"></div>
        <div class="rocket-box">🚀</div>
        <h2>US STOCK PAIR // $SPCX</h2>
        <h1>STARSHIP RESERVE</h1>
        <p>INTERPLANETARY LIQUIDITY ENGINE</p>
      </body>
      </html>
    `
  },
  {
    filename: 'mechazilla1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #1c1917 0%, #0c0a09 80%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .tower-box {
            z-index: 2; width: 210px; height: 210px; border-radius: 50%;
            background: rgba(28, 25, 23, 0.9); border: 4px solid #f59e0b;
            box-shadow: 0 0 40px #f59e0b;
            display: flex; align-items: center; justify-content: center;
            font-size: 88px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #fbbf24; margin-bottom: 6px; }
          h1 {
            font-size: 36px; font-weight: 900; letter-spacing: 2px;
            color: #fef3c7; text-shadow: 0 0 25px rgba(245, 158, 11, 0.7);
          }
          p { font-size: 13px; color: #f59e0b; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="tower-box">🥢</div>
        <h2>STARBASE TOWER // SPCX</h2>
        <h1>MECHAZILLA CATCH</h1>
        <p>CATCHING FALLING KNIVES IN MID-AIR</p>
      </body>
      </html>
    `
  },
  {
    filename: 'dragon1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #3b0707 0%, #1a0202 70%, #000 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .dragon-circle {
            z-index: 2; width: 220px; height: 220px; border-radius: 50%;
            background: radial-gradient(circle, #7f1d1d 0%, #450a0a 80%);
            border: 4px solid #facc15; box-shadow: 0 0 45px #facc15, inset 0 0 30px #dc2626;
            display: flex; align-items: center; justify-content: center;
            font-size: 96px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #f87171; margin-bottom: 6px; }
          h1 {
            font-size: 38px; font-weight: 900; letter-spacing: 3px;
            background: linear-gradient(to right, #facc15, #f87171);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 25px rgba(250, 204, 21, 0.6);
          }
          p { font-size: 13px; color: #fde047; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="dragon-circle">🐉</div>
        <h2>CHINA STOCK PAIR // $BABA</h2>
        <h1>GOLDEN DRAGON</h1>
        <p>AWAKENING EASTERN LIQUIDITY</p>
      </body>
      </html>
    `
  },
  {
    filename: 'jackma1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #271406 0%, #120701 80%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .avatar-box {
            z-index: 2; width: 210px; height: 210px; border-radius: 50%;
            background: radial-gradient(circle, #ea580c 0%, #9a3412 80%);
            border: 4px solid #fed7aa; box-shadow: 0 0 40px #ea580c;
            display: flex; align-items: center; justify-content: center;
            font-size: 88px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #fb923c; margin-bottom: 6px; }
          h1 {
            font-size: 36px; font-weight: 900; letter-spacing: 2px;
            color: #ffedd5; text-shadow: 0 0 25px rgba(234, 88, 12, 0.8);
          }
          p { font-size: 13px; color: #f97316; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="avatar-box">🥋</div>
        <h2>ALIBABA ECOSYSTEM // BABA</h2>
        <h1>JACK'S REVENGE</h1>
        <p>TAI CHI BONDING CURVE DEGEN</p>
      </body>
      </html>
    `
  },
  {
    filename: 'hbmchip1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #022c22 0%, #061916 60%, #010a08 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .chip-box {
            z-index: 2; width: 220px; height: 220px; border-radius: 24px;
            background: linear-gradient(135deg, #064e3b 0%, #022c22 100%);
            border: 4px solid #2dd4bf; box-shadow: 0 0 45px #2dd4bf, inset 0 0 25px #14b8a6;
            display: flex; align-items: center; justify-content: center;
            font-size: 84px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #5eead4; margin-bottom: 6px; }
          h1 {
            font-size: 38px; font-weight: 900; letter-spacing: 2px;
            background: linear-gradient(to right, #5eead4, #38bdf8);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 25px rgba(45, 212, 191, 0.6);
          }
          p { font-size: 13px; color: #2dd4bf; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="chip-box">💾</div>
        <h2>KOREA STOCK PAIR // $SKHY</h2>
        <h1>HBM SILICON</h1>
        <p>AI MEMORY SUPERCYCLE CORE</p>
      </body>
      </html>
    `
  },
  {
    filename: 'kimchi1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #2e0817 0%, #15020a 70%, #000 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .kimchi-circle {
            z-index: 2; width: 220px; height: 220px; border-radius: 50%;
            background: radial-gradient(circle, #be123c 0%, #881337 80%);
            border: 4px solid #f43f5e; box-shadow: 0 0 45px #f43f5e, inset 0 0 30px #fda4af;
            display: flex; align-items: center; justify-content: center;
            font-size: 96px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #fda4af; margin-bottom: 6px; }
          h1 {
            font-size: 38px; font-weight: 900; letter-spacing: 2px;
            background: linear-gradient(to right, #fb7185, #f43f5e);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 25px rgba(244, 63, 94, 0.8);
          }
          p { font-size: 13px; color: #fda4af; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="kimchi-circle">🌶️</div>
        <h2>SEOUL RETAIL MANIA // SKHY</h2>
        <h1>KIMCHI PREMIUM</h1>
        <p>LEGENDARY 30% K-PUMP SPREAD</p>
      </body>
      </html>
    `
  },
  {
    filename: 'aiagent1.jpg',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 512px; height: 512px;
            background: radial-gradient(circle at center, #022238 0%, #031320 60%, #000 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden; position: relative; color: #fff;
          }
          .ai-box {
            z-index: 2; width: 220px; height: 220px; border-radius: 50%;
            background: radial-gradient(circle, #0284c7 0%, #0369a1 80%);
            border: 4px solid #38bdf8; box-shadow: 0 0 45px #38bdf8, inset 0 0 30px #7dd3fc;
            display: flex; align-items: center; justify-content: center;
            font-size: 92px; margin-bottom: 20px;
          }
          h2 { font-size: 14px; letter-spacing: 5px; color: #7dd3fc; margin-bottom: 6px; }
          h1 {
            font-size: 38px; font-weight: 900; letter-spacing: 2px;
            background: linear-gradient(to right, #38bdf8, #818cf8);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 25px rgba(56, 189, 248, 0.8);
          }
          p { font-size: 13px; color: #38bdf8; letter-spacing: 2px; margin-top: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="ai-box">🤖</div>
        <h2>AUTONOMOUS BANKING // ETH</h2>
        <h1>RESERVE AGENT 0x</h1>
        <p>ALGORITHMIC QUANT LIQUIDITY</p>
      </body>
      </html>
    `
  }
];

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 512, height: 512 }
  });

  for (const img of images) {
    const targetPath = path.join(assetsDir, img.filename);
    console.log(`Rendering ${img.filename}...`);
    await page.setContent(img.html);
    // Wait slightly to ensure everything is rendered
    await page.waitForTimeout(50);
    await page.screenshot({
      path: targetPath,
      type: 'jpeg',
      quality: 92
    });
    console.log(`Saved ${targetPath} (${fs.statSync(targetPath).size} bytes)`);
  }

  await browser.close();
  console.log('All 12 meta assets successfully generated!');
}

run().catch(err => {
  console.error('Error generating assets:', err);
  process.exit(1);
});
