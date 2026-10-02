// Some compatible gateways return reasoning tags in content rather than a reasoning field.
// Never stream or persist that reasoning as the character's spoken response.
export function visibleText(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/giu, "")
    .replace(/<think(?:ing)?>[\s\S]*$/giu, "")
    .replace(/<[^>]*$/u, "");
}
