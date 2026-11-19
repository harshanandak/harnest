// Stand-in for the one export the Pi extension uses from @earendil-works/pi-ai.
// Pi provides the real package when it loads the extension; this copies its StringEnum (pi-ai 1.5.2).
export function StringEnum(values, options) {
  return {
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  };
}
