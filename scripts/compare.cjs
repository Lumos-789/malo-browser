const { ssim } = require("../out/main/video.js");

const [a, b, seconds] = process.argv.slice(2);
if (!a || !b) {
  console.error("用法: node scripts/compare.cjs <video-a> <video-b> [seconds]");
  process.exit(1);
}

ssim(a, b, Number(seconds ?? 8))
  .then((value) => console.log(`SSIM=${value.toFixed(4)}`))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
