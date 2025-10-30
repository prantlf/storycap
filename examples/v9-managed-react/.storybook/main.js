module.exports = {
  stories: ['../src/**/*.stories.@(js|jsx|mdx)'],
  addons: [
    '@storybook/addon-links',
    '@prantlf/storycap',
    '@storybook/preset-create-react-app',
  ],
  framework: {
    name: '@storybook/react-webpack5',
    options: {}
  },
  docs: {
    autodocs: true
  }
};
