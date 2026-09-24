// Deliberately loose: these classes come from a DIFFERENT @langchain/core than
// the app's, so typing them against the app's copy would be a lie.
export declare class ChatWeather {
  constructor(fields?: Record<string, unknown>);
  invoke(input: unknown, config?: object): Promise<{ content: unknown; tool_calls?: unknown[] }>;
}
export declare class WeatherRetriever {
  constructor(fields?: Record<string, unknown>);
  invoke(input: string, config?: object): Promise<unknown[]>;
}
export declare const weatherTool: {
  name: string;
  invoke(input: unknown, config?: object): Promise<unknown>;
};
export declare const forecast: {
  invoke(input: string, config?: object): Promise<string>;
};
