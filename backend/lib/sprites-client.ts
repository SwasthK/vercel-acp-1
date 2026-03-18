import { SpritesClient } from '@fly/sprites';

const spritesClient = new SpritesClient(process.env.SPRITES_TOKEN!);

export { spritesClient };