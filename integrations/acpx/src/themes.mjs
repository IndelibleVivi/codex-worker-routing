// SPDX-License-Identifier: SUL-1.0
// Shared paper palettes. The canonical cat in brand.mjs is never recoloured.
export const THEMES = [
  {
    id: 'sage', mascot: 'cat', name: {zh:'鼠尾草猫', en:'Sage cat'},
    colors: {paper:'#fdfdfb',surface:'#fffefa',mat:'#f1f2ec',shadow:'#deded5',ink:'#51415f',muted:'#77796f',primary:'#a9bd9b',primarySoft:'#edf2e5',primaryLine:'#acc099',secondary:'#efc5d5',secondarySoft:'#faedf1',secondaryLine:'#dfbecb',tertiary:'#65506f',tertiarySoft:'#f2eef5',tertiaryLine:'#cdc1d6',line:'#e2e7dc',track:'#e9ebe3',fourth:'#c6d3bd',fifth:'#b993ae',sixth:'#a2b9b3'},
  },
  {
    id: 'rose', mascot: 'rabbit', name: {zh:'燕麦玫瑰兔', en:'Oat bunny'},
    colors: {paper:'#fdfbf9',surface:'#fffdf9',mat:'#f1ede7',shadow:'#e2d9d0',ink:'#65504f',muted:'#7d706b',primary:'#bb9399',primarySoft:'#f5e9e8',primaryLine:'#d5b5b7',secondary:'#c9b48c',secondarySoft:'#f4eedf',secondaryLine:'#d9c8a8',tertiary:'#806d64',tertiarySoft:'#f1eae5',tertiaryLine:'#d6c5bb',line:'#e8ded7',track:'#eee5df',fourth:'#d8c3b6',fifth:'#a88787',sixth:'#b4b7a1'},
  },
  {
    id: 'mist', mascot: 'dog', name: {zh:'雾蓝奶油狗', en:'Mist puppy'},
    colors: {paper:'#fbfcfd',surface:'#fefefb',mat:'#edf1f3',shadow:'#d9e0e2',ink:'#455d6d',muted:'#6d7980',primary:'#89a7b7',primarySoft:'#e9f0f4',primaryLine:'#b4c9d3',secondary:'#dfc389',secondarySoft:'#faf3e2',secondaryLine:'#e3d2ad',tertiary:'#627a89',tertiarySoft:'#edf0f4',tertiaryLine:'#bfccd4',line:'#dfe7e9',track:'#e7edef',fourth:'#bbcdd5',fifth:'#b6a8b6',sixth:'#a2b8ae'},
  },
  {
    id: 'lavender', mascot: 'bear', name: {zh:'薰衣草杏熊', en:'Lilac bear'},
    colors: {paper:'#fdfbfe',surface:'#fffdfb',mat:'#f1eef4',shadow:'#e0d9e5',ink:'#60516f',muted:'#7a717e',primary:'#aa98c0',primarySoft:'#f0eaf7',primaryLine:'#c9b9db',secondary:'#e2b593',secondarySoft:'#fbefe4',secondaryLine:'#e7cbb3',tertiary:'#7b658c',tertiarySoft:'#f3eaf0',tertiaryLine:'#d6c0d0',line:'#e8deeb',track:'#ece5ef',fourth:'#d0c4df',fifth:'#c599af',sixth:'#acb9a7'},
  },
];
export function getTheme(id) {
  return THEMES.find(theme => theme.id === id) ?? THEMES[0];
}
