(function attach(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FlowChannelCatalogState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  function normalizeObject(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function listEnabledProviders(channel) {
    const providers = Array.isArray(channel && channel.providers) ? channel.providers : [];
    return providers.filter((item) => item && item.enabled !== false);
  }

  function resolveProvider(channel, preferred) {
    const preferredKey = String(preferred || '').trim();
    const enabledProviders = listEnabledProviders(channel);
    const keys = enabledProviders
      .map((item) => String(item.key || '').trim())
      .filter(Boolean);
    if (preferredKey && keys.includes(preferredKey)) return preferredKey;
    const selected = String((channel && channel.selected_provider) || '').trim();
    if (selected && keys.includes(selected)) return selected;
    return keys[0] || preferredKey || '1';
  }

  function resolveProviderConfig(channel, preferred) {
    const providerKey = resolveProvider(channel, preferred);
    const enabledProviders = listEnabledProviders(channel);
    return enabledProviders.find((item) => String(item && item.key || '').trim() === providerKey) || null;
  }

  function resolveProviderConstraints(provider) {
    const source = normalizeObject(provider);
    const direct = normalizeObject(source.constraints);
    if (Object.keys(direct).length) return direct;
    return normalizeObject(normalizeObject(source.extra).constraints);
  }

  function resolveConstraints(channel, preferred) {
    const channelConstraints = normalizeObject(channel && channel.constraints);
    const providerConstraints = resolveProviderConstraints(resolveProviderConfig(channel, preferred));
    if (!Object.keys(providerConstraints).length) return { ...channelConstraints };
    return {
      ...channelConstraints,
      ...providerConstraints,
    };
  }

  function requiresReferenceImage(channel, preferred) {
    return resolveConstraints(channel, preferred).requires_image === true;
  }

  return {
    listEnabledProviders,
    resolveProvider,
    resolveProviderConfig,
    resolveProviderConstraints,
    resolveConstraints,
    requiresReferenceImage,
  };
});
