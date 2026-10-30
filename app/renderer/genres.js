// Thumbnail idea templates per kind of channel: prompt ideas for ERNIE, a title style that suits
// the genre, badge suggestions and a starting layout. "{topic}" is replaced with the video title.

export const SIZE_PRESETS = [
  { id: 'yt', label: 'YouTube thumbnail · 1280×720', w: 1280, h: 720 },
  { id: 'yt-hd', label: 'YouTube HD · 1920×1080', w: 1920, h: 1080 },
  { id: 'shorts', label: 'Shorts / TikTok / Reels cover · 1080×1920', w: 1080, h: 1920 },
  { id: 'ig-square', label: 'Instagram post · 1080×1080', w: 1080, h: 1080 },
  { id: 'ig-portrait', label: 'Instagram portrait · 1080×1350', w: 1080, h: 1350 },
  { id: 'social', label: 'Facebook / LinkedIn link · 1200×630', w: 1200, h: 630 },
  { id: 'x', label: 'X (Twitter) post · 1600×900', w: 1600, h: 900 },
  { id: 'podcast', label: 'Podcast cover · 3000×3000', w: 3000, h: 3000 },
  { id: 'banner', label: 'YouTube channel banner · 2560×1440', w: 2560, h: 1440 },
];

/** Size ERNIE paints at for an output size: same shape, about 1.2 megapixels, multiples of 16. */
export function genSize(w, h, mp = 1.2e6) {
  const k = Math.min(1, Math.sqrt(mp / (w * h)));
  const r16 = v => Math.max(256, Math.min(2048, Math.round(v / 16) * 16));
  return { w: r16(w * k), h: r16(h * k) };
}

const S = (font, color, accent, outline, extra = {}) => ({ font, color, accent, outline, upper: true, ...extra });

export const GENRES = [
  { id: 'art', label: 'Art & drawing', style: S('Futura', '#ffffff', '#ff5ca8', '#1a0f2e', { pos: 'left' }), badges: ['SPEEDPAINT', 'TUTORIAL', 'BEFORE / AFTER'],
    prompts: [
      'An artist’s desk seen from above, a vivid half-finished painting of {topic} surrounded by brushes, paint tubes and colourful splashes, soft studio window light, rich saturated colours, open space on the left',
      'A dramatic glowing canvas showing {topic} in bold expressive brush strokes, paint splatter frozen mid-air, dark studio background with warm rim light, painterly style',
      'Colourful pencils and markers fanned around a sketchbook with a striking drawing of {topic}, top-down flat lay, clean bright light, playful composition',
    ] },
  { id: 'cooking', label: 'Cooking & food', style: S('Avenir Next Condensed', '#ffffff', '#ffd23f', '#3a1a00', { pos: 'left' }), badges: ['EASY', '15 MIN', 'ONE PAN', 'VEGAN'],
    prompts: [
      'A mouth-watering close-up of {topic} on a rustic wooden table, steam rising, glistening sauce, shallow depth of field, warm golden kitchen light, food photography, empty space on the left',
      'A hero shot of {topic} in a cast-iron pan with fresh herbs and colourful ingredients scattered around, overhead angle, bright natural light, vibrant appetising colours',
      'A cosy home kitchen at golden hour with {topic} on the counter, flour dust in the light, cinematic food styling',
    ] },
  { id: 'gaming', label: 'Gaming', style: S('Impact', '#ffffff', '#00e5ff', '#000000', { pos: 'left' }), badges: ['NEW', 'INSANE', 'WORLD RECORD', 'BEST BUILD'],
    prompts: [
      'An epic video-game scene about {topic}, a heroic character in dynamic action pose, explosions and neon light trails, dramatic low angle, high contrast, glowing cyan and magenta',
      'A dark arena lit by neon with a giant boss creature looming over a small hero, {topic}, intense atmosphere, volumetric fog, game key art style',
      'A colourful cartoon game world bursting with loot, coins and power-ups, {topic}, bright saturated 3D render, playful energy',
    ] },
  { id: 'tech', label: 'Tech & reviews', style: S('SF Pro Display', '#ffffff', '#3ea6ff', '#0a1020', { pos: 'left' }), badges: ['REVIEW', 'VS', 'HOW TO', '2026'],
    prompts: [
      'A sleek modern gadget representing {topic} floating above a reflective surface, soft blue rim light, dark gradient background, product photography, minimal, open space on the left',
      'A clean desk setup with a glowing laptop and devices, {topic}, cool blue and orange lighting, bokeh, high-end tech commercial look',
      'Exploded view of a device with glowing circuit details about {topic}, futuristic HUD lines, dark background, crisp 3D render',
    ] },
  { id: 'fitness', label: 'Fitness & health', style: S('Avenir Next Condensed', '#ffffff', '#b6ff3b', '#0b1a00', { pos: 'right' }), badges: ['30 DAY', 'NO GYM', 'BEGINNER'],
    prompts: [
      'An athletic person mid-workout in a gritty gym, chalk dust in the air, dramatic side light, sweat and determination, {topic}, high contrast, energetic',
      'A bright outdoor training scene at sunrise, runner silhouetted against the sky, {topic}, motivational, warm lens flare',
      'Healthy colourful meal-prep containers and a dumbbell on a clean counter, {topic}, bright and fresh',
    ] },
  { id: 'travel', label: 'Travel & vlog', style: S('Avenir Next', '#ffffff', '#ffb02a', '#002033', { pos: 'bottom' }), badges: ['DAY 1', 'HIDDEN GEM', '24 HOURS IN'],
    prompts: [
      'A breathtaking travel view of {topic} at golden hour, a traveller with a backpack looking out over the landscape, cinematic wide shot, vivid colours',
      'A lively street scene in {topic} with lanterns, market stalls and people, warm evening light, travel photography, shallow depth of field',
      'Turquoise water, white sand and a hidden cove, {topic}, drone view, summer colours, dreamy',
    ] },
  { id: 'music', label: 'Music', style: S('Futura', '#ffffff', '#ff3b30', '#000000', { pos: 'center' }), badges: ['COVER', 'LIVE', 'TUTORIAL', 'BEAT BREAKDOWN'],
    prompts: [
      'A musician performing {topic} on a smoky stage, dramatic coloured spotlights and haze, silhouette and glowing instrument, concert photography',
      'Close-up of hands on a vintage synthesizer with glowing knobs and cables, {topic}, moody purple and orange light, shallow depth of field',
      'An abstract sound-wave landscape in neon colours representing {topic}, retro-futuristic, album-cover style',
    ] },
  { id: 'education', label: 'Education & explainers', style: S('Avenir Next', '#ffffff', '#ffd60a', '#102040', { pos: 'left' }), badges: ['EXPLAINED', 'IN 5 MIN', 'FOR BEGINNERS'],
    prompts: [
      'A clear illustrated concept of {topic}, friendly isometric 3D diagram with labelled-looking shapes but no text, soft pastel colours, clean white background',
      'A curious scene that makes {topic} intriguing: a giant magnifying glass revealing hidden details, bright playful lighting, editorial illustration',
      'A chalkboard-style dark background with glowing doodles and icons about {topic}, no readable words, warm accent colours',
    ] },
  { id: 'beauty', label: 'Beauty & fashion', style: S('Didot', '#ffffff', '#ff8fb1', '#2a0a14', { pos: 'right', upper: false }), badges: ['GRWM', 'GLOW UP', 'TRY ON'],
    prompts: [
      'Elegant beauty products and flowers arranged on a pastel pink surface, {topic}, soft diffused light, luxury magazine style',
      'A stylish fashion portrait in a sunlit studio with flowing fabric, {topic}, editorial photography, warm tones',
      'Glossy makeup swatches and brushes in a dreamy composition, {topic}, peach and gold colours, close-up',
    ] },
  { id: 'finance', label: 'Money & business', style: S('Avenir Next Condensed', '#ffffff', '#38d36b', '#00140a', { pos: 'left' }), badges: ['$10K', 'PASSIVE INCOME', 'DON’T DO THIS'],
    prompts: [
      'A rising stock chart made of glowing green light over a dark city skyline at night, {topic}, dramatic and cinematic',
      'Stacks of coins and a small growing plant on a desk, {topic}, warm morning light, clean business photography',
      'A businessperson at a crossroads with two glowing paths, {topic}, conceptual, high contrast',
    ] },
  { id: 'diy', label: 'DIY & home', style: S('Rockwell', '#ffffff', '#ff9f1c', '#1c1206', { pos: 'left' }), badges: ['BEFORE / AFTER', 'BUDGET', 'WEEKEND BUILD'],
    prompts: [
      'A cosy workshop bench with tools, sawdust and a beautiful handmade project about {topic}, warm tungsten light, shallow depth of field',
      'A bright renovated room reveal, {topic}, natural light, interior design photography, inviting',
      'Hands crafting {topic} on a wooden table, close-up, detailed textures, warm and friendly',
    ] },
  { id: 'podcast', label: 'Podcast & talk', style: S('Avenir Next Condensed', '#ffffff', '#ffb02a', '#000000', { pos: 'bottom' }), badges: ['EP. 1', 'FULL EPISODE', 'CLIP'],
    prompts: [
      'A moody podcast studio with two microphones on boom arms, warm amber light and acoustic panels, {topic}, cinematic, bokeh background',
      'A single vintage broadcast microphone in dramatic spotlight against a deep colour gradient, {topic}, minimal',
      'An abstract conversation concept: two speech-bubble shaped lights facing each other in a dark room, {topic}, artistic',
    ] },
  { id: 'kids', label: 'Kids & family', style: S('Marker Felt', '#ffffff', '#ffde00', '#3b1f7a', { pos: 'center', upper: false }), badges: ['FUN', 'EASY', 'FOR KIDS'],
    prompts: [
      'A bright cheerful cartoon world about {topic}, cute round characters, rainbow colours, soft 3D style, playful',
      'A colourful craft table with paper, glitter and crayons, {topic}, top-down, bright and happy',
      'A friendly cartoon animal explaining {topic} in a sunny park, children’s book illustration',
    ] },
  { id: 'screencast', label: 'Screen tutorial', style: S('SF Pro Display', '#ffffff', '#ffb02a', '#0a0a0a', { pos: 'left', inset: true }), badges: ['TUTORIAL', 'TIPS', 'STEP BY STEP'],
    prompts: [
      'A clean desk with a glowing computer screen and soft gradient backdrop, {topic}, modern productivity aesthetic, blue and orange light, open space for a title',
      'Floating app windows and cursor icons in 3D space with soft shadows, {topic}, colourful gradient background, crisp render',
      'An abstract keyboard and mouse scene lit by neon, {topic}, tech tutorial vibe',
    ] },
];

export const genreById = id => GENRES.find(g => g.id === id) || null;

/** Template prompts for a genre and topic (used when the AI prompt writer isn't available). */
export function genreIdeas(genre, topic) {
  const t = (topic || 'the video').replace(/\s+/g, ' ').trim();
  return (genre ? genre.prompts : GENRES[0].prompts).map(p => p.replaceAll('{topic}', t) + '. No text, no letters.');
}
