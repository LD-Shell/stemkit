/**
 * @module core/figure
 *
 * One description of a scientific figure, read by both renderers: the Plotly
 * preview on the page (js/figure-plot.js) and the matplotlib script the page
 * writes (figure-python.js). It extends the plot-style contract
 * (plot-style.js): the figure's look uses the same names with the same
 * meanings (sizes in inches and points, tick objects, legend positions, the
 * export settings), and adds what a figure of any kind needs:
 *
 *   - one or more panels stacked vertically, sharing the x axis, each with its
 *     own y axis and a height ratio;
 *   - categorical x (named groups at 0, 1, 2 … for bars and boxes);
 *   - series of these kinds, drawn in the order given:
 *       line       a line through (x, y), optionally with markers or as steps
 *       scatter    markers at (x, y)
 *       errorbar   markers with x and/or y error bars, with caps
 *       band       the area between lower and upper over x
 *       bar        bars on categories or at x, grouped side by side, with
 *                  y error bars
 *       histogram  counts of raw values in bins, or counts already binned
 *       box        box and whiskers for groups of values, with fliers,
 *                  jittered points and the mean with its confidence interval
 *       heatmap    a z grid coloured through a colormap, with a colour bar
 *       contour    lines or filled bands at levels of a z grid, colour bar
 *       hline, vline, axline   reference lines (horizontal, vertical, through
 *                  two points or one point and a slope)
 *       text       a note placed in data or axes coordinates
 *       bracket    a significance bracket between two x positions
 *   - a default colour cycle that is safe for colour-blind readers, in one set
 *     of steps for light figure backgrounds and one for dark, and matplotlib's
 *     sequential and diverging colormaps, value for value.
 *
 * normaliseFigure() turns a partial or hand-written description into a
 * complete one, as normalisePlotStyle does for a style: unknown values fall
 * back to the defaults, numbers are kept in range, and the numbers each kind
 * needs are worked out once here (the bins of a histogram, the quartiles of a
 * box, the offsets of grouped bars) so that the preview and the script draw
 * the same thing.
 *
 * A data field is an array of numbers, or { values, name?, source?, column?,
 * py? }: `values` is what the preview draws; the rest tells the script where
 * the numbers come from (a Python name to embed them under, a column of one of
 * the user's files, or a Python expression the script has already computed).
 *
 * The look a person sets in the style panel is kept apart from the page's
 * description as a partial object (see applyStyle): the page redraws with new
 * data, the person's choices stay.
 */

import {
  MARKERS, LINE_STYLES, FONT_FAMILIES, LEGEND_POSITIONS, TICK_MODES, TICK_DIRECTIONS, EXPORT_FORMATS, GRID_AXES, SIZE_UNITS,
  defaultPlotStyle
} from './plot-style.js';
import { studentTQuantile } from './nonlinear-fit.js';

export const SERIES_KINDS = Object.freeze([
  'line', 'scatter', 'errorbar', 'band', 'bar', 'histogram', 'box',
  'heatmap', 'contour', 'hline', 'vline', 'axline', 'text', 'bracket'
]);
export const HISTOGRAM_TYPES = Object.freeze(['stepfilled', 'step', 'bar']);
export const STEP_MODES = Object.freeze(['pre', 'mid', 'post']);
export const TEXT_ALIGN = Object.freeze(['left', 'center', 'right']);
export const TEXT_VALIGN = Object.freeze(['baseline', 'bottom', 'center', 'top']);

/**
 * The default colours, in the order series take them. Checked for
 * colour-blind readers (adjacent pairs at least ΔE 8 in OKLab under deutan,
 * protan and tritan simulation, 18 without) and for 3:1 contrast on the
 * figure's background; the first is the site's Prussian blue. Past three
 * series on one scatter, tell them apart by marker too.
 */
export const COLOR_CYCLE = Object.freeze(['#1f5c96', '#e8590c', '#0f9d76', '#b87a00', '#d55181', '#2f8f2f', '#7b61c9', '#d64545']);
/** The same hues stepped for a dark figure background. */
export const COLOR_CYCLE_DARK = Object.freeze(['#4a8fd4', '#e0622a', '#1aa376', '#c98500', '#d85a88', '#2f9a2f', '#9085e9', '#e66767']);

/* matplotlib's colormaps, 256 entries each, as its lookup tables hold them. */
const LUTS = {
  viridis: '44015444025645045745055946075a46085c460a5d460b5e470d60470e6147106347116447136548146748166848176948186a481a6c481b6d481c6e481d6f481f70482071482173482374482475482576482677482878482979472a7a472c7a472d7b472e7c472f7d46307e46327e46337f463480453581453781453882443983443a83443b84433d84433e85423f854240864241864142874144874045884046883f47883f48893e49893e4a893e4c8a3d4d8a3d4e8a3c4f8a3c508b3b518b3b528b3a538b3a548c39558c39568c38588c38598c375a8c375b8d365c8d365d8d355e8d355f8d34608d34618d33628d33638d32648e32658e31668e31678e31688e30698e306a8e2f6b8e2f6c8e2e6d8e2e6e8e2e6f8e2d708e2d718e2c718e2c728e2c738e2b748e2b758e2a768e2a778e2a788e29798e297a8e297b8e287c8e287d8e277e8e277f8e27808e26818e26828e26828e25838e25848e25858e24868e24878e23888e23898e238a8d228b8d228c8d228d8d218e8d218f8d21908d21918c20928c20928c20938c1f948c1f958b1f968b1f978b1f988b1f998a1f9a8a1e9b8a1e9c891e9d891f9e891f9f881fa0881fa1881fa1871fa28720a38620a48621a58521a68522a78522a88423a98324aa8325ab8225ac8226ad8127ad8128ae8029af7f2ab07f2cb17e2db27d2eb37c2fb47c31b57b32b67a34b67935b77937b87838b9773aba763bbb753dbc743fbc7340bd7242be7144bf7046c06f48c16e4ac16d4cc26c4ec36b50c46a52c56954c56856c66758c7655ac8645cc8635ec96260ca6063cb5f65cb5e67cc5c69cd5b6ccd5a6ece5870cf5773d05675d05477d1537ad1517cd2507fd34e81d34d84d44b86d54989d5488bd6468ed64590d74393d74195d84098d83e9bd93c9dd93ba0da39a2da37a5db36a8db34aadc32addc30b0dd2fb2dd2db5de2bb8de29bade28bddf26c0df25c2df23c5e021c8e020cae11fcde11dd0e11cd2e21bd5e21ad8e219dae319dde318dfe318e2e418e5e419e7e419eae51aece51befe51cf1e51df4e61ef6e620f8e621fbe723fde725',
  cividis: '00224e00234f00245100255300255400265600275800285900285b00295d002a5f002a61002b62002c64002c66002d68002e6a002e6c002f6d00306f0030700031700031710132710533710833700c34700f357012357014367016377018376f1a386f1c396f1e3a6f203a6f213b6e233c6e243c6e263d6e273e6e293f6e2a3f6d2b406d2d416d2e416d2f426d31436d32436d33446d34456c35456c36466c38476c39486c3a486c3b496c3c4a6c3d4a6c3e4b6c3f4c6c404c6c414d6c424e6c434e6c444f6c45506c46516c47516c48526c49536c4a536c4b546c4c556c4d556c4e566c4f576c50576c51586d52596d535a6d545a6d555b6d555c6d565c6d575d6d585e6d595e6e5a5f6e5b606e5c616e5d616e5e626e5e636f5f636f60646f61656f62656f636670646770656870656870666970676a71686a71696b716a6c716b6d726c6d726c6e726d6f726e6f736f70737071737172747272747273747374757474757575757676767777767777777878777979777a7a787b7a787c7b787d7c787e7c787e7d787f7e78807f78817f788280798381798482798582798683798784788885788985788a86788b87788c88788d88788e89788f8a78908b78918b78928c78928d78938e78948e77958f779690779791779892779992779a93769b94769c95769d95769e96769f9775a09875a19975a29975a39a74a49b74a59c74a69c74a79d73a89e73a99f73aaa073aba072aca172ada272aea371afa471b0a571b1a570b3a670b4a76fb5a86fb6a96fb7a96eb8aa6eb9ab6dbaac6dbbad6dbcae6cbdae6cbeaf6bbfb06bc0b16ac1b26ac2b369c3b369c4b468c5b568c6b667c7b767c8b866c9b965cbb965ccba64cdbb63cebc63cfbd62d0be62d1bf61d2c060d3c05fd4c15fd5c25ed6c35dd7c45cd9c55cdac65bdbc75adcc859ddc858dec958dfca57e0cb56e1cc55e2cd54e4ce53e5cf52e6d051e7d150e8d24fe9d34eead34cebd44bedd54aeed649efd748f0d846f1d945f2da44f3db42f5dc41f6dd3ff7de3ef8df3cf9e03afbe138fce236fde334fee434fee535fee636fee838',
  plasma: '0d088710078813078916078a19068c1b068d1d068e20068f2206902406912605912805922a05932c05942e05952f059631059733059735049837049938049a3a049a3c049b3e049c3f049c41049d43039e44039e46039f48039f4903a04b03a14c02a14e02a25002a25102a35302a35502a45601a45801a45901a55b01a55c01a65e01a66001a66100a76300a76400a76600a76700a86900a86a00a86c00a86e00a86f00a87100a87201a87401a87501a87701a87801a87a02a87b02a87d03a87e03a88004a88104a78305a78405a78606a68707a68808a68a09a58b0aa58d0ba58e0ca48f0da4910ea3920fa39410a29511a19613a19814a099159f9a169f9c179e9d189d9e199da01a9ca11b9ba21d9aa31e9aa51f99a62098a72197a82296aa2395ab2494ac2694ad2793ae2892b02991b12a90b22b8fb32c8eb42e8db52f8cb6308bb7318ab83289ba3388bb3488bc3587bd3786be3885bf3984c03a83c13b82c23c81c33d80c43e7fc5407ec6417dc7427cc8437bc9447aca457acb4679cc4778cc4977cd4a76ce4b75cf4c74d04d73d14e72d24f71d35171d45270d5536fd5546ed6556dd7566cd8576bd9586ada5a6ada5b69db5c68dc5d67dd5e66de5f65de6164df6263e06363e16462e26561e26660e3685fe4695ee56a5de56b5de66c5ce76e5be76f5ae87059e97158e97257ea7457eb7556eb7655ec7754ed7953ed7a52ee7b51ef7c51ef7e50f07f4ff0804ef1814df1834cf2844bf3854bf3874af48849f48948f58b47f58c46f68d45f68f44f79044f79143f79342f89441f89540f9973ff9983ef99a3efa9b3dfa9c3cfa9e3bfb9f3afba139fba238fca338fca537fca636fca835fca934fdab33fdac33fdae32fdaf31fdb130fdb22ffdb42ffdb52efeb72dfeb82cfeba2cfebb2bfebd2afebe2afec029fdc229fdc328fdc527fdc627fdc827fdca26fdcb26fccd25fcce25fcd025fcd225fbd324fbd524fbd724fad824fada24f9dc24f9dd25f8df25f8e125f7e225f7e425f6e626f6e826f5e926f5eb27f4ed27f3ee27f3f027f2f227f1f426f1f525f0f724f0f921',
  magma: '00000401000501010601010802010902020b02020d03030f03031204041405041606051806051a07061c08071e0907200a08220b09240c09260d0a290e0b2b100b2d110c2f120d31130d34140e36150e38160f3b180f3d19103f1a10421c10441d11471e114920114b21114e22115024125325125527125829115a2a115c2c115f2d11612f116331116533106734106936106b38106c390f6e3b0f703d0f713f0f72400f74420f75440f764510774710784910784a10794c117a4e117b4f127b51127c52137c54137d56147d57157e59157e5a167e5c167f5d177f5f187f601880621980641a80651a80671b80681c816a1c816b1d816d1d816e1e81701f81721f817320817521817621817822817922827b23827c23827e24828025828125818326818426818627818827818928818b29818c29818e2a81902a81912b81932b80942c80962c80982d80992d809b2e7f9c2e7f9e2f7fa02f7fa1307ea3307ea5317ea6317da8327daa337dab337cad347cae347bb0357bb2357bb3367ab5367ab73779b83779ba3878bc3978bd3977bf3a77c03a76c23b75c43c75c53c74c73d73c83e73ca3e72cc3f71cd4071cf4070d0416fd2426fd3436ed5446dd6456cd8456cd9466bdb476adc4869de4968df4a68e04c67e24d66e34e65e44f64e55064e75263e85362e95462ea5661eb5760ec5860ed5a5fee5b5eef5d5ef05f5ef1605df2625df2645cf3655cf4675cf4695cf56b5cf66c5cf66e5cf7705cf7725cf8745cf8765cf9785df9795df97b5dfa7d5efa7f5efa815ffb835ffb8560fb8761fc8961fc8a62fc8c63fc8e64fc9065fd9266fd9467fd9668fd9869fd9a6afd9b6bfe9d6cfe9f6dfea16efea36ffea571fea772fea973feaa74feac76feae77feb078feb27afeb47bfeb67cfeb77efeb97ffebb81febd82febf84fec185fec287fec488fec68afec88cfeca8dfecc8ffecd90fecf92fed194fed395fed597fed799fed89afdda9cfddc9efddea0fde0a1fde2a3fde3a5fde5a7fde7a9fde9aafdebacfcecaefceeb0fcf0b2fcf2b4fcf4b6fcf6b8fcf7b9fcf9bbfcfbbdfcfdbf',
  inferno: '00000401000501010601010802010a02020c02020e03021004031204031405041706041907051b08051d09061f0a07220b07240c08260d08290e092b10092d110a30120a32140b34150b37160b39180c3c190c3e1b0c411c0c431e0c451f0c48210c4a230c4c240c4f260c51280b53290b552b0b572d0b592f0a5b310a5c320a5e340a5f3609613809623909633b09643d09653e0966400a67420a68440a68450a69470b6a490b6a4a0c6b4c0c6b4d0d6c4f0d6c510e6c520e6d540f6d550f6d57106e59106e5a116e5c126e5d126e5f136e61136e62146e64156e65156e67166e69166e6a176e6c186e6d186e6f196e71196e721a6e741a6e751b6e771c6d781c6d7a1d6d7c1d6d7d1e6d7f1e6c801f6c82206c84206b85216b87216b88226a8a226a8c23698d23698f24699025689225689326679526679727669827669a28659b29649d29649f2a63a02a63a22b62a32c61a52c60a62d60a82e5fa92e5eab2f5ead305dae305cb0315bb1325ab3325ab43359b63458b73557b93556ba3655bc3754bd3853bf3952c03a51c13a50c33b4fc43c4ec63d4dc73e4cc83f4bca404acb4149cc4248ce4347cf4446d04545d24644d34743d44842d54a41d74b3fd84c3ed94d3dda4e3cdb503bdd513ade5238df5337e05536e15635e25734e35933e45a31e55c30e65d2fe75e2ee8602de9612bea632aeb6429eb6628ec6726ed6925ee6a24ef6c23ef6e21f06f20f1711ff1731df2741cf3761bf37819f47918f57b17f57d15f67e14f68013f78212f78410f8850ff8870ef8890cf98b0bf98c0af98e09fa9008fa9207fa9407fb9606fb9706fb9906fb9b06fb9d07fc9f07fca108fca309fca50afca60cfca80dfcaa0ffcac11fcae12fcb014fcb216fcb418fbb61afbb81dfbba1ffbbc21fbbe23fac026fac228fac42afac62df9c72ff9c932f9cb35f8cd37f8cf3af7d13df7d340f6d543f6d746f5d949f5db4cf4dd4ff4df53f4e156f3e35af3e55df2e661f2e865f2ea69f1ec6df1ed71f1ef75f1f179f2f27df2f482f3f586f3f68af4f88ef5f992f6fa96f8fb9af9fc9dfafda1fcffa4',
  turbo: '30123b32154333184a341b51351e5836215f37246638276d392a733a2d793b2f803c32863d358b3e38913f3b973f3e9c4040a24143a74146ac4249b1424bb5434eba4451bf4454c34456c74559cb455ccf455ed34661d64664da4666dd4669e0466be3476ee64771e94773eb4776ee4778f0477bf2467df44680f64682f84685fa4687fb458afc458cfd448ffe4391fe4294ff4196ff4099ff3e9bfe3d9efe3ba0fd3aa3fc38a5fb37a8fa35abf833adf731aff52fb2f42eb4f22cb7f02ab9ee28bceb27bee925c0e723c3e422c5e220c7df1fc9dd1ecbda1ccdd81bd0d51ad2d21ad4d019d5cd18d7ca18d9c818dbc518ddc218dec018e0bd19e2bb19e3b91ae4b61ce6b41de7b21fe9af20eaac22ebaa25eca727eea42aefa12cf09e2ff19b32f29835f39438f4913cf58e3ff68a43f78746f8844af8804ef97d52fa7a55fa7659fb735dfc6f61fc6c65fd6969fd666dfe6271fe5f75fe5c79fe597dff5680ff5384ff5188ff4e8bff4b8fff4992ff4796fe4499fe429cfe409ffd3fa1fd3da4fc3ca7fc3aa9fb39acfb38affa37b1f936b4f836b7f735b9f635bcf534bef434c1f334c3f134c6f034c8ef34cbed34cdec34d0ea34d2e935d4e735d7e535d9e436dbe236dde037dfdf37e1dd37e3db38e5d938e7d739e9d539ebd339ecd13aeecf3aefcd3af1cb3af2c93af4c73af5c53af6c33af7c13af8be39f9bc39faba39fbb838fbb637fcb336fcb136fdae35fdac34fea933fea732fea431fea130fe9e2ffe9b2dfe992cfe962bfe932afe9029fd8d27fd8a26fc8725fc8423fb8122fb7e21fa7b1ff9781ef9751df8721cf76f1af66c19f56918f46617f36315f26014f15d13f05b12ef5811ed5510ec530feb500eea4e0de84b0ce7490ce5470be4450ae2430ae14109df3f08dd3d08dc3b07da3907d83706d63506d43305d23105d02f05ce2d04cc2b04ca2a04c82803c52603c32503c12302be2102bc2002b91e02b71d02b41b01b21a01af1801ac1701a91601a71401a41301a112019e10019b0f01980e01950d01920b018e0a018b09028808028507028106027e05027a0403',
  coolwarm: '3b4cc03c4ec23d50c33e51c53f53c64055c84257c94358cb445acc455cce465ecf485fd14961d24a63d34b64d54c66d64e68d84f69d9506bda516ddb536edd5470de5572df5673e05875e15977e35a78e45b7ae55d7ce65e7de75f7fe86180e96282ea6384eb6485ec6687ed6788ee688aef6a8bef6b8df06c8ff16e90f26f92f37093f37295f47396f57597f67699f6779af7799cf87a9df87b9ff97da0f97ea1fa80a3fa81a4fb82a6fb84a7fc85a8fc86a9fc88abfd89acfd8badfd8caffe8db0fe8fb1fe90b2fe92b4fe93b5fe94b6ff96b7ff97b8ff98b9ff9abbff9bbcff9dbdff9ebeff9fbfffa1c0ffa2c1ffa3c2fea5c3fea6c4fea7c5fea9c6fdaac7fdabc8fdadc9fdaec9fcafcafcb1cbfcb2ccfbb3cdfbb5cdfab6cefab7cff9b9d0f9bad0f8bbd1f8bcd2f7bed2f6bfd3f6c0d4f5c1d4f4c3d5f4c4d5f3c5d6f2c6d6f1c7d7f0c9d7f0cad8efcbd8eeccd9edcdd9eccedaebcfdaead1dae9d2dbe8d3dbe7d4dbe6d5dbe5d6dce4d7dce3d8dce2d9dce1dadce0dbdcdedcdddddddcdcdedcdbdfdbd9e0dbd8e1dad6e2dad5e3d9d3e4d9d2e5d8d1e6d7cfe7d7cee8d6cce9d5cbead5c9ead4c8ebd3c6ecd3c5edd2c3edd1c2eed0c0efcfbfefcebdf0cdbbf1cdbaf1ccb8f2cbb7f2cab5f2c9b4f3c8b2f3c7b1f4c6aff4c5adf5c4acf5c2aaf5c1a9f5c0a7f6bfa6f6bea4f6bda2f7bca1f7ba9ff7b99ef7b89cf7b79bf7b599f7b497f7b396f7b194f7b093f7af91f7ad90f7ac8ef7aa8cf7a98bf7a889f7a688f6a586f6a385f6a283f5a081f59f80f59d7ef59c7df49a7bf4987af39778f39577f39475f29274f29072f18f71f18d6ff08b6ef08a6cef886bee8669ee8468ed8366ec8165ec7f63eb7d62ea7b60e97a5fe9785de8765ce7745be67259e57058e46e56e36c55e36b54e26952e16751e0654fdf634ede614ddd5f4bdc5d4ada5a49d95847d85646d75445d65244d55042d44e41d24b40d1493fd0473dcf453ccd423bcc403acb3e38ca3b37c83836c73635c53334c43032c32e31c12b30c0282fbe242ebd1f2dbb1b2cba162bb8122ab70d28b50927b40426',
  RdBu_r: '05306106326407346708366a09386d0a3b700c3d730d3f760e41790f437b10457e114781124984134c87144e8a15508d1752901854931956961a58991b5a9c1c5c9f1d5fa21e61a51f63a82065ab2267ac2369ad246aae266caf276eb02870b12a71b22b73b32c75b42e77b52f79b5307ab6327cb7337eb83480b93681ba3783bb3885bc3a87bd3b88be3c8abe3e8cbf3f8ec0408fc14291c24393c34695c44997c54c99c64f9bc7529dc8569fc959a1ca5ca3cb5fa5cd62a7ce65a9cf68abd06bacd16eaed271b0d375b2d478b4d57bb6d67eb8d781bad884bcd987beda8ac0db8dc2dc90c4dd93c6de96c7df98c8e09bc9e09dcbe1a0cce2a2cde3a5cee3a7d0e4a9d1e5acd2e5aed3e6b1d5e7b3d6e8b6d7e8b8d8e9bbdaeabddbeac0dcebc2ddecc5dfecc7e0edcae1eecce2efcfe4efd1e5f0d2e6f0d4e6f1d5e7f1d7e8f1d8e9f1dae9f2dbeaf2ddebf2deebf2e0ecf3e1edf3e3edf3e4eef4e6eff4e7f0f4e9f0f4eaf1f5ecf2f5edf2f5eff3f5f0f4f6f2f5f6f3f5f6f5f6f7f6f7f7f7f6f6f7f5f4f8f4f2f8f3f0f8f2eff8f1edf9f0ebf9efe9f9eee7f9ede5f9ebe3faeae1fae9dffae8defae7dcfbe6dafbe5d8fbe4d6fbe3d4fce2d2fce0d0fcdfcffcdecdfdddcbfddcc9fddbc7fdd9c4fcd7c2fcd5bffcd3bcfbd0b9fbceb7fbccb4facab1fac8aff9c6acf9c4a9f9c2a7f8bfa4f8bda1f8bb9ef7b99cf7b799f7b596f6b394f6b191f6af8ef5ac8bf5aa89f5a886f4a683f3a481f2a17ff19e7df09c7bef9979ee9677ec9374eb9172ea8e70e98b6ee8896ce6866ae58368e48066e37e64e27b62e17860df765ede735cdd7059dc6e57db6b55da6853d86551d7634fd6604dd55d4cd35a4ad25849d05548cf5246ce4f45cc4c44cb4942c94741c84440c6413ec53e3dc43b3cc2383ac13639bf3338be3036bd2d35bb2a34ba2832b82531b72230b61f2eb41c2db3192cb1182bae172aab162aa81529a51429a213289f12289c1127991027960f27930e26900d268d0c258a0b25870a248409248108237f08237c07227906227605217304217003206d02206a011f67001f',
  RdYlBu_r: '313695323896333b97333d9934409a35429b36459c36479e374a9f384ca0394fa13a51a23a54a43b56a53c59a63d5ba73e5ea83e60aa3f62ab4065ac4167ad416aaf426cb0436fb14471b24574b34676b54878b64a7ab74b7db84d7fb94f81ba5183bb5385bd5588be578abf588cc05a8ec15c90c25e93c36095c46297c66399c7659bc8679ec969a0ca6ba2cb6da4cc6ea6ce70a9cf72abd074add176afd278b0d37ab2d47db4d57fb6d681b7d783b9d885bbd987bdd98abeda8cc0db8ec2dc90c3dd92c5de94c7df97c9e099cae19bcce29dcee39fd0e4a1d1e5a3d3e6a6d5e7a8d6e8aad8e9acdae9aedbeab0dceab2ddebb4deecb6dfecb9e0edbbe1edbde2eebfe3efc1e4efc3e5f0c5e6f0c7e7f1c9e8f2cbe9f2cdeaf3cfebf3d1ecf4d4edf4d6eef5d8eff6daf0f6dcf1f7def2f7e0f3f8e1f3f6e2f4f4e4f4f1e5f5efe6f5ede7f6ebe9f6e8eaf7e6ebf7e4ecf8e2edf8dfeff9ddf0f9dbf1fad9f2fad6f3fbd4f5fbd2f6fbd0f7fccef8fccbfafdc9fbfdc7fcfec5fdfec2feffc0fffebefffdbcfffcbafffbb9fffab7fff8b5fff7b3fff6b1fff5affff3adfff2acfff1aafff0a8feefa6feeda4feeca2feeba1feea9ffee99dfee79bfee699fee597fee496fee294fee192fee090fede8efedc8cfeda8afed889fed687fed485fed283fed081fece7ffecc7efeca7cfec87afdc778fdc576fdc374fdc173fdbf71fdbd6ffdbb6dfdb96bfdb769fdb567fdb366fdb164fdaf62fdad60fcaa5ffca85efca55dfba35cfba05bfb9d59fa9b58fa9857fa9656f99355f99153f98e52f88c51f88950f8864ff7844ef7814cf67f4bf67c4af67a49f57748f57547f57245f47044f46d43f36b42f26841f16640ef633fee613eed5f3cec5c3beb5a3aea5739e95538e75337e65036e54e35e44c34e34933e24731e14430e0422fde402edd3d2ddc3b2cdb382bda362ad93429d83128d62f27d42d27d22b27d02927ce2827cc2627ca2427c82227c62027c41e27c21c27c01a27be1827bd1726bb1526b91326b71126b50f26b30d26b10b26af0926ad0826ab0626a90426a70226a50026',
  Blues: 'f7fbfff6fafff5fafef5f9fef4f9fef3f8fef2f8fdf2f7fdf1f7fdf0f6fdeff6fceef5fceef5fcedf4fcecf4fbebf3fbeaf3fbeaf2fbe9f2fae8f1fae7f1fae7f0fae6f0f9e5eff9e4eff9e3eef9e3eef8e2edf8e1edf8e0ecf8dfecf7dfebf7deebf7ddeaf7dceaf6dce9f6dbe9f6dae8f6d9e8f5d9e7f5d8e7f5d7e6f5d6e6f4d6e5f4d5e5f4d4e4f4d3e4f3d3e3f3d2e3f3d1e2f3d0e2f2d0e1f2cfe1f2cee0f2cde0f1cddff1ccdff1cbdef1cadef0caddf0c9ddf0c8dcf0c7dcefc7dbefc6dbefc4daeec3daeec2d9eec1d9edbfd8edbed8ecbdd7ecbcd7ebbad6ebb9d6eab8d5eab7d4eab5d4e9b4d3e9b3d3e8b2d2e8b0d2e7afd1e7aed1e7add0e6abd0e6aacfe5a9cfe5a8cee4a6cee4a5cde3a4cce3a3cce3a1cbe2a0cbe29fcae19dcae19cc9e19ac8e099c7e097c6df95c5df94c4df92c4de91c3de8fc2de8dc1dd8cc0dd8abfdd89bedc87bddc85bcdc84bcdb82bbdb81badb7fb9da7db8da7cb7da7ab6d979b5d977b5d975b4d874b3d872b2d871b1d76fb0d76dafd76caed66aaed669add568acd566abd465aad464a9d363a8d361a7d260a7d25fa6d15da5d15ca4d05ba3d05aa2cf58a1cf57a0ce56a0ce549fcd539ecd529dcc519ccc4f9bcb4e9acb4d99ca4b98ca4a98c94997c94896c84695c84594c74493c74292c64191c64090c53f8fc53e8ec43d8dc43c8cc33b8bc23a8ac23989c13888c13787c03686c03585bf3484bf3383be3282be3181bd3080bd2f7fbc2e7ebc2d7dbb2c7cba2b7bba2a7ab92979b92777b82676b82575b72474b72373b62272b62171b52070b4206fb41f6eb31e6db21d6cb11c6bb01c6ab01b69af1a68ae1967ad1966ad1865ac1764ab1663aa1562a91561a91460a8135fa7125ea6125da6115ca5105ba40f5aa30e59a20e58a20d57a10c56a00b559f0a549e0a539e09529d08519c08509b084f99084e98084d96084c95084b93084a9108499008488e08478d08468b08458a084488084387084285084184084082083e81083d7f083c7d083b7c083a7a08397908387708377608367408357308347108337008326e08316d08306b',
  Greys: 'fffffffffffffefefefefefefdfdfdfdfdfdfcfcfcfcfcfcfbfbfbfbfbfbfafafafafafaf9f9f9f9f9f9f8f8f8f8f8f8f7f7f7f7f7f7f7f7f7f6f6f6f6f6f6f5f5f5f5f5f5f4f4f4f4f4f4f3f3f3f3f3f3f2f2f2f2f2f2f1f1f1f1f1f1f0f0f0f0f0f0efefefeeeeeeeeeeeeedededececececececebebebeaeaeae9e9e9e9e9e9e8e8e8e7e7e7e7e7e7e6e6e6e5e5e5e4e4e4e4e4e4e3e3e3e2e2e2e1e1e1e1e1e1e0e0e0dfdfdfdfdfdfdedededddddddcdcdcdcdcdcdbdbdbdadadadadadad9d9d9d8d8d8d7d7d7d6d6d6d5d5d5d4d4d4d4d4d4d3d3d3d2d2d2d1d1d1d0d0d0cfcfcfcecececdcdcdcccccccccccccbcbcbcacacac9c9c9c8c8c8c7c7c7c6c6c6c5c5c5c5c5c5c4c4c4c3c3c3c2c2c2c1c1c1c0c0c0bfbfbfbebebebebebebdbdbdbbbbbbbababab9b9b9b8b8b8b6b6b6b5b5b5b4b4b4b3b3b3b2b2b2b0b0b0afafafaeaeaeadadadabababaaaaaaa9a9a9a8a8a8a7a7a7a5a5a5a4a4a4a3a3a3a2a2a2a0a0a09f9f9f9e9e9e9d9d9d9c9c9c9a9a9a9999999898989797979595959494949393939292929191919090908f8f8f8e8e8e8d8d8d8c8c8c8a8a8a8989898888888787878686868585858484848383838282828181817f7f7f7e7e7e7d7d7d7c7c7c7b7b7b7a7a7a7979797878787777777676767575757373737272727171717070706f6f6f6e6e6e6d6d6d6c6c6c6b6b6b6a6a6a6969696868686767676666666565656464646363636262626161616060605f5f5f5e5e5e5d5d5d5c5c5c5b5b5b5a5a5a5858585757575656565555555454545353535252525151515050504e4e4e4d4d4d4b4b4b4a4a4a4848484747474646464444444343434141414040403f3f3f3d3d3d3c3c3c3a3a3a3939393838383636363535353333333232323030302f2f2f2e2e2e2c2c2c2b2b2b2929292828282727272525252424242323232222222121211f1f1f1e1e1e1d1d1d1c1c1c1b1b1b1a1a1a1818181717171616161515151414141313131111111010100f0f0f0e0e0e0d0d0d0c0c0c0a0a0a090909080808070707060606050505030303020202010101000000'
};
export const COLORMAPS = Object.freeze(Object.keys(LUTS));
const lutCache = new Map();

/**
 * A colormap as 256 '#rrggbb' colours, index 0 for the lowest value.
 *
 * @param {string} name - one of COLORMAPS; anything else gives viridis
 * @returns {string[]}
 */
export function colormapColors(name) {
  const key = Object.hasOwn(LUTS, name) ? name : 'viridis';
  if (!lutCache.has(key)) {
    const hex = LUTS[key];
    lutCache.set(key, Object.freeze(Array.from({ length: 256 }, (_, i) => `#${hex.slice(6 * i, 6 * i + 6)}`)));
  }
  return lutCache.get(key);
}

/**
 * The lookup-table index matplotlib uses for a value: Normalize to [0, 1],
 * then floor(t × 256), 255 for t = 1; below vmin the lowest colour, above
 * vmax the highest (the colormap's under and over colours), -1 for NaN
 * (drawn transparent).
 */
export function colormapIndex(v, vmin, vmax) {
  if (!Number.isFinite(v)) return -1;
  let t = (v - vmin) / (vmax - vmin);
  if (!Number.isFinite(t)) t = 0;
  t *= 256;
  if (t < 0) return 0;
  if (t >= 256) return 255;
  return Math.floor(t);
}

/** The colour of `v` on a colormap between vmin and vmax, or null for NaN. */
export function colormapColor(name, v, vmin, vmax) {
  const i = colormapIndex(v, vmin, vmax);
  return i < 0 ? null : colormapColors(name)[i];
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const isColour = (c) => typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim());
const hex6 = (c) => {
  const h = String(c).trim().toLowerCase();
  return h.length === 4 ? '#' + [...h.slice(1)].map((q) => q + q).join('') : h;
};
const colour = (v, fallback) => (isColour(v) ? hex6(v) : fallback);
const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const optionalSize = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.min(60, Math.max(4, Number(v))));
const optNum = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const text = (v, fallback) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);
const bool = (v, fallback) => (v === undefined || v === null ? fallback : !!v);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const toNum = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
/* The smallest and largest of an array of any length (Math.min(...a) runs
   out of stack past about 100 000 values). */
const minOf = (a, start = Infinity) => { let m = start; for (const v of a) if (v < m) m = v; return m; };
const maxOf = (a, start = -Infinity) => { let m = start; for (const v of a) if (v > m) m = v; return m; };
const limit = (pair) => {
  const a = Array.isArray(pair) ? pair : [null, null];
  return [optNum(a[0]), optNum(a[1])];
};

/** Relative luminance of a '#rrggbb' colour, 0 (black) to 1 (white). */
export function luminance(hex) {
  const h = hex6(colour(hex, '#ffffff')).slice(1);
  const f = (i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}

/**
 * How many of a unit make an inch: the figure's size is kept in inches and
 * shown in the unit chosen (px at the figure's dpi).
 */
export function unitsPerInch(unit, dpi = 300) {
  return { cm: 2.54, mm: 25.4, px: Number(dpi) || 300 }[unit] || 1;
}

/** A size in inches written in a unit: '85 mm', '3.35 in', '1004 px'. */
export function formatSize(inches, unit = 'in', dpi = 300) {
  const v = inches * unitsPerInch(unit, dpi);
  const digits = unit === 'px' ? 0 : unit === 'mm' ? 1 : unit === 'cm' ? 2 : 3;
  const text = unit === 'in' ? String(Number(v.toPrecision(3))) : String(Number(v.toFixed(digits)));
  return `${text} ${unit}`;
}

/** The colour cycle that reads on a figure background. */
export function colorCycle(background = '#ffffff') {
  return luminance(background) < 0.2 ? COLOR_CYCLE_DARK : COLOR_CYCLE;
}

/**
 * A data field as numbers plus where the script finds them.
 *
 * @returns {{values: number[], ref: {name?: string, source?: string, column?: string|number, py?: string}|null}}
 */
function dataField(v) {
  if (v === null || v === undefined) return { values: null, ref: null };
  if (ArrayBuffer.isView(v) || Array.isArray(v)) return { values: Array.from(v, toNum), ref: null };
  if (typeof v === 'object') {
    const values = v.values === undefined || v.values === null ? null : Array.from(v.values, toNum);
    const ref = {};
    if (typeof v.name === 'string' && v.name) ref.name = v.name;
    if (typeof v.source === 'string' && v.source) ref.source = v.source;
    if (typeof v.column === 'string' || Number.isInteger(v.column)) ref.column = v.column;
    if (typeof v.py === 'string' && v.py.trim()) ref.py = v.py.trim();
    // A grid listed point by point (as PLUMED's fes.dat): the columns of its x and y.
    for (const k of ['x', 'y']) if (typeof v[k] === 'string' || Number.isInteger(v[k])) ref[k] = v[k];
    return { values, ref: Object.keys(ref).length ? ref : null };
  }
  const n = toNum(v);
  return { values: [n], ref: null };
}

/* A z grid: rows along y, as matplotlib's Z[j][i] at (x[i], y[j]). */
function gridField(v, nx, ny) {
  if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) {
    const ref = dataField({ ...v, values: [] }).ref;
    if (Array.isArray(v.values) && Array.isArray(v.values[0])) return { rows: v.values.map((r) => Array.from(r, toNum)), ref };
    const flat = v.values ? Array.from(v.values, toNum) : [];
    const [r, c] = Array.isArray(v.shape) ? v.shape.map(Number) : [ny, nx];
    return { rows: Array.from({ length: r || 0 }, (_, j) => flat.slice(j * c, j * c + c)), ref };
  }
  if (Array.isArray(v)) return { rows: v.map((r) => Array.from(r || [], toNum)), ref: null };
  return { rows: [], ref: null };
}

/* ------------------------------------------------------------------ *
 * Statistics the kinds need, done as numpy and matplotlib do them
 * ------------------------------------------------------------------ */

/** numpy.percentile's default (linear) of sorted values. */
function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  // numpy's _lerp: a + (b - a) * t, and b - (b - a) * (1 - t) past the middle.
  const t = h - lo;
  const a = sorted[lo]; const b = sorted[hi];
  const d = b - a;
  return t >= 0.5 ? b - d * (1 - t) : a + d * t;
}

/**
 * The statistics matplotlib's boxplot draws (cbook.boxplot_stats), plus the
 * mean and its t-based confidence interval.
 *
 * @param {number[]} values - NaN are left out
 * @param {{whis?: number, level?: number}} [options]
 * @returns {{n: number, q1: number, med: number, q3: number, whislo: number, whishi: number,
 *   fliers: number[], mean: number, ciLow: number, ciHigh: number}|null}
 */
export function boxStats(values, { whis = 1.5, level = 0.95 } = {}) {
  const x = Array.from(values || [], toNum).filter(Number.isFinite);
  if (!x.length) return null;
  const s = x.slice().sort((a, b) => a - b);
  const q1 = percentile(s, 0.25); const med = percentile(s, 0.5); const q3 = percentile(s, 0.75);
  const iqr = q3 - q1;
  const loval = q1 - whis * iqr; const hival = q3 + whis * iqr;
  const hiIn = s.filter((v) => v <= hival);
  const loIn = s.filter((v) => v >= loval);
  const whishi = !hiIn.length || maxOf(hiIn) < q3 ? q3 : maxOf(hiIn);
  const whislo = !loIn.length || minOf(loIn) > q1 ? q1 : minOf(loIn);
  const n = x.length;
  let total = 0;
  for (const v of x) total += v;
  const mean = total / n;
  let half = NaN;
  if (n > 1) {
    let ss = 0;
    for (const v of x) ss += (v - mean) ** 2;
    const sd = Math.sqrt(ss / (n - 1));
    half = studentTQuantile((1 + level) / 2, n - 1) * sd / Math.sqrt(n);
  }
  return {
    n, q1, med, q3, whislo, whishi,
    fliers: x.filter((v) => v < whislo || v > whishi),
    mean, ciLow: mean - half, ciHigh: mean + half
  };
}

/** numpy.linspace(start, stop, num), element for element. */
export function linspace(start, stop, num) {
  const n = Math.max(0, Math.floor(num));
  if (n === 1) return [start];
  const step = (stop - start) / (n - 1);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = step === 0 ? (i / (n - 1)) * (stop - start) + start : i * step + start;
  if (n > 1) out[n - 1] = stop;
  return out;
}

/**
 * numpy.histogram: counts of the finite values in bins, [e_i, e_i+1) and the
 * last bin closed. `bins` is a number of equal bins between the smallest and
 * largest value (numpy's rule, including ±0.5 when they are equal) or the
 * edges themselves.
 *
 * @returns {{counts: number[], edges: number[]}}
 */
export function histogram(values, bins = 10, { density = false } = {}) {
  const a = Array.from(values || [], toNum).filter(Number.isFinite);
  let edges;
  let uniform = null;
  if (Array.isArray(bins) || ArrayBuffer.isView(bins)) {
    edges = Array.from(bins, Number).filter(Number.isFinite);
  } else {
    const n = Math.max(1, Math.round(Number(bins) || 10));
    let lo = a.length ? minOf(a) : 0;
    let hi = a.length ? maxOf(a) : 1;
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    edges = linspace(lo, hi, n + 1);
    uniform = { lo, hi, n };
  }
  const nb = Math.max(0, edges.length - 1);
  const counts = new Array(nb).fill(0);
  if (!nb) return { counts, edges };
  if (uniform) {
    // numpy's fast path, with its fix-ups against the edges it made.
    const norm = uniform.n / (uniform.hi - uniform.lo);
    for (const v of a) {
      if (v < uniform.lo || v > uniform.hi) continue;
      let i = Math.trunc((v - uniform.lo) * norm);
      if (i === uniform.n) i -= 1;
      if (v < edges[i]) i -= 1;
      if (v >= edges[i + 1] && i !== uniform.n - 1) i += 1;
      counts[i] += 1;
    }
  } else {
    const s = a.slice().sort((x, y) => x - y);
    const search = (e, right) => {
      let lo = 0; let hi = s.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (right ? s[mid] <= e : s[mid] < e) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const cum = [...edges.slice(0, -1).map((e) => search(e, false)), search(edges[nb], true)];
    for (let i = 0; i < nb; i++) counts[i] = cum[i + 1] - cum[i];
  }
  if (density) {
    const total = counts.reduce((x, y) => x + y, 0);
    return { counts: counts.map((c, i) => c / (total * (edges[i + 1] - edges[i]))), edges };
  }
  return { counts, edges };
}

/** The jitter of point k of n in a box, as a share of the box width: evenly spread, the same every time (in the script too). */
export function jitterOffsets(n, spread) {
  return Array.from({ length: n }, (_, k) => (((k * 0.6180339887498949) % 1) - 0.5) * spread);
}

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

/* The look of the whole figure: plot-style's own fields and defaults. */
const FIGURE_LOOK = ['width', 'height', 'dpi', 'fontFamily', 'fontSize', 'title', 'background', 'foreground',
  'legend', 'grid', 'spines', 'export', 'colormap', 'xLabel', 'xScale', 'xLim', 'xTicks', 'sizeUnit', 'titleSize', 'tickSize'];
const PANEL_LOOK = ['yLabel', 'yScale', 'yLim', 'yTicks', 'ratio', 'legend'];
const SERIES_LOOK = ['show', 'label', 'legend', 'color', 'alpha', 'lineWidth', 'lineStyle', 'marker', 'size', 'edgeColor',
  'edgeWidth', 'errorWidth', 'capSize', 'width', 'histtype', 'colormap', 'vmin', 'vmax', 'levels', 'colorbar', 'colors',
  'filled', 'points', 'pointSize', 'mean', 'fliers', 'fontSize', 'step', 'faceAlpha', 'medianColor'];

/** A figure with nothing in it: one empty panel and plot-style's look. */
export function defaultFigure() {
  const s = defaultPlotStyle();
  return {
    width: s.width, height: s.height, dpi: s.dpi, sizeUnit: 'in', fontFamily: s.fontFamily, fontSize: s.fontSize,
    titleSize: null, tickSize: null,
    title: '', background: s.background, foreground: s.foreground,
    legend: { ...s.legend, title: '', columns: 1 },
    grid: s.grid, spines: s.spines,
    export: { ...s.export, filename: 'figure' },
    colormap: 'viridis',
    xLabel: '', xScale: 'linear', xLim: [null, null], xTicks: s.xTicks, xCategories: null,
    panels: [defaultPanel()]
  };
}

function defaultPanel() {
  const s = defaultPlotStyle();
  return { id: 'main', name: '', ratio: 1, yLabel: '', yScale: 'linear', yLim: [null, null], yTicks: s.yTicks, legend: { show: null, position: null, order: [] }, series: [] };
}

function normaliseTicks(t, d) {
  const src = obj(t);
  const values = Array.isArray(src.values) ? src.values.map(Number).filter(Number.isFinite) : [];
  return {
    mode: pick(src.mode, TICK_MODES, d.mode),
    step: src.step === null || src.step === undefined || src.step === '' ? null : num(src.step, 1e-300, 1e300, null),
    count: src.count === null || src.count === undefined || src.count === '' ? null : Math.round(num(src.count, 2, 50, 5)),
    values,
    labels: Array.isArray(src.labels) ? src.labels.slice(0, values.length).map(String) : [],
    minor: !!src.minor,
    direction: pick(src.direction, TICK_DIRECTIONS, d.direction),
    length: num(src.length, 0, 20, d.length),
    width: num(src.width, 0, 5, d.width),
    format: typeof src.format === 'string' ? src.format.trim() : '',
    mirror: !!src.mirror
  };
}

/* ------------------------------------------------------------------ *
 * Series
 * ------------------------------------------------------------------ */

function colorbarOf(v, filled) {
  if (v === false) return { show: false, label: '' };
  if (v === true) return { show: true, label: '' };
  const c = obj(v);
  return { show: bool(c.show, filled), label: text(c.label, '') };
}

/*
 * One series, complete. `ctx` gives the figure (for colours) and counts the
 * series that take a colour from the cycle.
 */
function normaliseSeries(src, ctx, index) {
  const s = obj(src);
  const kind = pick(s.kind, SERIES_KINDS, 'line');
  const cycle = colorCycle(ctx.background);
  const takesColour = !['hline', 'vline', 'axline', 'text', 'bracket', 'heatmap'].includes(kind) && !(kind === 'contour' && s.filled);
  // As matplotlib's property cycle: a series with a colour of its own does
  // not use up one of the cycle's.
  const auto = takesColour && !isColour(s.color) ? cycle[ctx.cycle++ % cycle.length] : ctx.foreground;
  const base = {
    id: text(s.id, '') || `${kind}${index + 1}`,
    kind,
    show: bool(s.show, true),
    label: text(s.label, ''),
    legend: bool(s.legend, true),
    color: colour(s.color, auto),
    alpha: num(s.alpha, 0, 1, 1),
    zorder: optNum(s.zorder)
  };
  // A normalised series keeps where its data come from.
  const refs = { ...obj(s.refs) };
  const field = (key) => {
    const f = dataField(s[key]);
    if (f.ref) refs[key] = f.ref;
    return f.values;
  };
  const lineStyle = (d) => pick(s.lineStyle, LINE_STYLES, d);
  const marker = (d) => pick(s.marker, MARKERS, d);
  let out;
  switch (kind) {
    case 'line': {
      const x = field('x') || []; const y = field('y') || [];
      out = { ...base, x, y, lineWidth: num(s.lineWidth, 0, 20, 1.5), lineStyle: lineStyle('solid'), marker: marker('none'),
        size: num(s.size, 0, 40, 6), step: pick(s.step, STEP_MODES, null) };
      break;
    }
    case 'scatter': {
      const x = field('x') || []; const y = field('y') || [];
      const m = marker('o');
      out = { ...base, x, y, marker: m === 'none' ? 'o' : m, size: num(s.size, 0, 40, 6), edgeColor: colour(s.edgeColor, base.color),
        edgeWidth: num(s.edgeWidth, 0, 10, 1) };
      break;
    }
    case 'errorbar': {
      const x = field('x') || []; const y = field('y') || [];
      const err = (key) => {
        const v = s[key];
        if (Array.isArray(v) && v.length === 2 && (Array.isArray(v[0]) || (v[0] && typeof v[0] === 'object'))) {
          const lo = dataField(v[0]); const hi = dataField(v[1]);
          if (lo.ref || hi.ref) refs[key] = [lo.ref || {}, hi.ref || {}];
          return [lo.values || [], hi.values || []];
        }
        const f = dataField(v);
        if (f.ref) refs[key] = f.ref;
        return f.values ? [f.values, f.values] : null;
      };
      out = { ...base, x, y, xerr: err('xerr'), yerr: err('yerr'), marker: marker('o'), size: num(s.size, 0, 40, 6),
        edgeColor: colour(s.edgeColor, base.color), edgeWidth: num(s.edgeWidth, 0, 10, 1),
        errorWidth: num(s.errorWidth, 0.1, 10, 1), capSize: num(s.capSize, 0, 20, 0),
        lineWidth: num(s.lineWidth, 0, 20, 1.5), lineStyle: s.lineStyle && s.lineStyle !== 'none' ? lineStyle('solid') : 'none' };
      break;
    }
    case 'band': {
      out = { ...base, x: field('x') || [], lower: field('lower') || [], upper: field('upper') || [],
        alpha: num(s.alpha, 0, 1, 0.2), edgeWidth: num(s.edgeWidth, 0, 10, 0) };
      break;
    }
    case 'bar': {
      let x = field('x');
      const y = field('y') || [];
      if (!x) x = y.map((_, i) => i);
      out = { ...base, x, y, yerr: null, width: num(s.width, 0.05, 1, 0.8), bottom: num(s.bottom, -1e300, 1e300, 0),
        edgeColor: colour(s.edgeColor, base.color), edgeWidth: num(s.edgeWidth, 0, 10, 0),
        errorWidth: num(s.errorWidth, 0.1, 10, 1), capSize: num(s.capSize, 0, 20, 3),
        errorColor: colour(s.errorColor, ctx.foreground), group: bool(s.group, true), offset: 0, barWidth: 0 };
      const e = s.yerr;
      if (Array.isArray(e) && e.length === 2 && (Array.isArray(e[0]) || (e[0] && typeof e[0] === 'object'))) {
        out.yerr = [dataField(e[0]).values || [], dataField(e[1]).values || []];
      } else if (e !== undefined && e !== null) {
        const f = dataField(e);
        if (f.ref) refs.yerr = f.ref;
        out.yerr = f.values ? [f.values, f.values] : null;
      }
      break;
    }
    case 'histogram': {
      const values = field('values');
      const counts = field('counts');
      const givenEdges = Array.isArray(s.edges) ? s.edges.map(Number) : null;
      const bins = Array.isArray(s.bins) ? s.bins.map(Number) : Math.round(num(s.bins, 1, 10000, 10));
      const density = !!s.density;
      let h;
      if (values) h = histogram(values, givenEdges || bins, { density });
      else h = { counts: counts || [], edges: givenEdges || [] };
      out = { ...base, values: values || null, bins, density, counts: h.counts, edges: h.edges,
        histtype: pick(s.histtype, HISTOGRAM_TYPES, 'stepfilled'),
        alpha: num(s.alpha, 0, 1, s.histtype === 'step' ? 1 : 0.6),
        edgeColor: colour(s.edgeColor, base.color), edgeWidth: num(s.edgeWidth, 0, 10, s.histtype === 'step' ? 1.5 : 0),
        lineWidth: num(s.lineWidth, 0, 10, 1.5) };
      if (out.histtype === 'step' && s.edgeWidth === undefined) out.edgeWidth = out.lineWidth;
      break;
    }
    case 'box': {
      const groups = Array.isArray(s.groups) ? s.groups : [];
      const whis = num(s.whis, 0, 100, 1.5);
      const level = num(s.level, 0.5, 0.999, 0.95);
      const gs = groups.map((g, i) => {
        const gg = Array.isArray(g) || ArrayBuffer.isView(g) ? { values: g } : obj(g);
        const f = dataField(gg.values);
        return { position: optNum(gg.position) ?? i, values: (f.values || []).filter(Number.isFinite), ref: f.ref || gg.ref || null, stats: boxStats(f.values || [], { whis, level }) };
      });
      out = { ...base, groups: gs, whis, level, width: num(s.width, 0.05, 1, 0.5), faceAlpha: num(s.faceAlpha, 0, 1, 0.25),
        lineWidth: num(s.lineWidth, 0, 10, 1), medianColor: colour(s.medianColor, ctx.foreground), fliers: bool(s.fliers, true),
        points: bool(s.points, false), pointSize: num(s.pointSize, 0, 30, 4), jitter: num(s.jitter, 0, 1, 0.3),
        mean: bool(s.mean, false), meanOffset: num(s.meanOffset, -1, 1, 0), marker: marker('o'), legend: false };
      if (out.points && s.fliers === undefined) out.fliers = false;
      break;
    }
    case 'heatmap': {
      const x = field('x') || []; const y = field('y') || [];
      const z = gridField(s.z, x.length, y.length);
      if (z.ref) refs.z = z.ref;
      out = { ...base, x, y, z: z.rows, colormap: pick(s.colormap, COLORMAPS, ctx.colormap), vmin: optNum(s.vmin), vmax: optNum(s.vmax),
        colorbar: colorbarOf(s.colorbar, true), legend: false };
      break;
    }
    case 'contour': {
      const x = field('x') || []; const y = field('y') || [];
      const z = gridField(s.z, x.length, y.length);
      if (z.ref) refs.z = z.ref;
      const filled = !!s.filled;
      const levels = Array.isArray(s.levels) ? s.levels.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : Math.round(num(s.levels, 1, 100, 7));
      out = { ...base, x, y, z: z.rows, filled, levels, colormap: pick(s.colormap, COLORMAPS, ctx.colormap),
        colors: s.colors === null || s.colors === 'colormap' ? null : colour(s.colors, filled ? null : ctx.foreground),
        vmin: optNum(s.vmin), vmax: optNum(s.vmax),
        lineWidth: num(s.lineWidth, 0, 10, filled ? 0 : 0.8), lineStyle: lineStyle('solid'),
        colorbar: colorbarOf(s.colorbar, filled), legend: false };
      if (!filled && s.colors === undefined && s.colormap !== undefined) out.colors = null;
      if (out.colors) out.color = out.colors;
      break;
    }
    case 'hline': case 'vline': {
      const at = optNum(kind === 'hline' ? s.y : s.x);
      out = { ...base, [kind === 'hline' ? 'y' : 'x']: at ?? 0, lineWidth: num(s.lineWidth, 0, 20, 1), lineStyle: lineStyle('dashed'),
        color: colour(s.color, ctx.foreground) };
      break;
    }
    case 'axline': {
      const p = Array.isArray(s.points) ? s.points : [];
      const p0 = Array.isArray(p[0]) ? p[0].map(Number) : [0, 0];
      const slope = optNum(s.slope);
      const p1 = Array.isArray(p[1]) ? p[1].map(Number) : slope === null ? [1, 1] : null;
      out = { ...base, points: p1 ? [p0, p1] : [p0], slope: p1 ? null : slope, lineWidth: num(s.lineWidth, 0, 20, 1),
        lineStyle: lineStyle('dashed'), color: colour(s.color, ctx.foreground) };
      break;
    }
    case 'text': {
      out = { ...base, x: num(s.x, -1e300, 1e300, 0), y: num(s.y, -1e300, 1e300, 0), text: text(s.text, ''),
        coords: pick(s.coords, ['data', 'axes'], 'data'), ha: pick(s.ha, TEXT_ALIGN, 'left'), va: pick(s.va, TEXT_VALIGN, 'baseline'),
        fontSize: num(s.fontSize, 4, 60, ctx.tickSize), rotation: s.rotation === 90 ? 90 : 0,
        color: colour(s.color, ctx.foreground), legend: false };
      break;
    }
    case 'bracket': {
      out = { ...base, x1: num(s.x1, -1e300, 1e300, 0), x2: num(s.x2, -1e300, 1e300, 1), y: num(s.y, -1e300, 1e300, 0),
        height: optNum(s.height), text: text(s.text, '*'), fontSize: num(s.fontSize, 4, 60, ctx.tickSize),
        lineWidth: num(s.lineWidth, 0, 10, 1), color: colour(s.color, ctx.foreground), legend: false };
      break;
    }
    default:
      out = base;
  }
  out.refs = refs;
  return out;
}

/* Side-by-side offsets of the bar series that share positions in a panel. */
function groupBars(series) {
  const bars = series.filter((s) => s.kind === 'bar' && s.group && s.show);
  const n = bars.length;
  bars.forEach((b, i) => {
    b.barWidth = b.width / Math.max(1, n);
    b.offset = n > 1 ? (i - (n - 1) / 2) * b.barWidth : 0;
  });
  series.filter((s) => s.kind === 'bar' && (!s.group || !s.show)).forEach((b) => { b.barWidth = b.width; b.offset = 0; });
}

/* A bracket's height, when not given: 2.5% of the span of the panel's data. */
function bracketHeights(series) {
  if (!series.some((s) => s.kind === 'bracket' && s.height === null)) return;
  let lo = 0; let hi = -Infinity;
  const see = (v) => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  for (const s of series) {
    if (s.kind === 'bar') s.y.forEach((v, i) => { see(v + s.bottom); if (s.yerr) see(v + s.bottom + (s.yerr[1][i] || 0)); });
    else if (s.kind === 'box') {
      s.groups.forEach((g) => {
        if (!g.stats) return;
        see(g.stats.whislo); see(g.stats.whishi);
        for (const v of g.stats.fliers) see(v);
        if (s.points) for (const v of g.values) see(v);
      });
    } else if (Array.isArray(s.y)) for (const v of s.y) see(v);
    else if (s.kind === 'bracket') see(s.y);
  }
  const span = hi > -Infinity ? hi - lo : 1;
  series.filter((s) => s.kind === 'bracket' && s.height === null).forEach((s) => { s.height = 0.025 * (span || 1); });
}

/* ------------------------------------------------------------------ *
 * The figure
 * ------------------------------------------------------------------ */

/**
 * A complete, valid figure from a partial description. Series take colours
 * from the cycle, in order, unless they have their own.
 *
 * @param {object} [fig]
 * @returns {object} see defaultFigure; each panel's series normalised, and
 *   `refs` on each series saying where the script finds its data
 */
export function normaliseFigure(fig = {}) {
  const d = defaultFigure();
  const s = obj(fig);
  const sub = (key) => obj(s[key]);
  const background = colour(s.background, d.background);
  const foreground = colour(s.foreground, d.foreground);
  const fontSize = num(s.fontSize, 4, 40, d.fontSize);
  const out = {
    width: num(s.width, 1, 30, d.width),
    height: num(s.height, 1, 30, d.height),
    dpi: Math.round(num(s.dpi, 50, 1200, d.dpi)),
    sizeUnit: pick(s.sizeUnit, SIZE_UNITS, d.sizeUnit),
    fontFamily: pick(s.fontFamily, FONT_FAMILIES, d.fontFamily),
    fontSize,
    titleSize: optionalSize(s.titleSize),
    tickSize: optionalSize(s.tickSize),
    title: text(s.title, d.title),
    background,
    foreground,
    legend: {
      show: bool(sub('legend').show, d.legend.show),
      position: pick(sub('legend').position, LEGEND_POSITIONS, d.legend.position),
      frame: bool(sub('legend').frame, d.legend.frame),
      fontSize: num(sub('legend').fontSize, 4, 40, d.legend.fontSize),
      title: text(sub('legend').title, ''),
      columns: Math.round(num(sub('legend').columns, 1, 10, 1))
    },
    grid: {
      show: bool(sub('grid').show, d.grid.show),
      minor: !!sub('grid').minor,
      color: colour(sub('grid').color, d.grid.color),
      alpha: num(sub('grid').alpha, 0, 1, d.grid.alpha),
      style: pick(sub('grid').style, LINE_STYLES, d.grid.style),
      width: num(sub('grid').width, 0.1, 5, d.grid.width),
      axis: pick(sub('grid').axis, GRID_AXES, d.grid.axis)
    },
    spines: {
      top: bool(sub('spines').top, d.spines.top),
      right: bool(sub('spines').right, d.spines.right),
      width: num(sub('spines').width, 0, 5, d.spines.width)
    },
    export: {
      format: pick(sub('export').format, EXPORT_FORMATS, d.export.format),
      filename: (text(sub('export').filename, d.export.filename).replace(/[^\w.-]+/g, '_') || d.export.filename),
      transparent: !!sub('export').transparent,
      tight: bool(sub('export').tight, d.export.tight)
    },
    colormap: pick(s.colormap, COLORMAPS, d.colormap),
    xLabel: text(s.xLabel, d.xLabel),
    xScale: pick(s.xScale, ['linear', 'log'], d.xScale),
    xLim: limit(s.xLim),
    xTicks: normaliseTicks(s.xTicks, d.xTicks),
    xCategories: Array.isArray(s.xCategories) && s.xCategories.length ? s.xCategories.map((c) => text(c, String(c))) : null,
    panels: []
  };
  if (out.xCategories) out.xScale = 'linear';
  const ctx = { background, foreground, fontSize, tickSize: out.tickSize ?? Math.max(1, fontSize - 1), colormap: out.colormap, cycle: 0 };
  const panels = Array.isArray(s.panels) && s.panels.length ? s.panels : [{}];
  const ids = new Set();
  out.panels = panels.slice(0, 8).map((p, pi) => {
    const src = obj(p);
    const dp = defaultPanel();
    const lg = obj(src.legend);
    const panel = {
      id: text(src.id, '') || (pi === 0 ? 'main' : `panel${pi + 1}`),
      name: text(src.name, ''),
      ratio: num(src.ratio, 0.05, 20, 1),
      yLabel: text(src.yLabel, dp.yLabel),
      yScale: pick(src.yScale, ['linear', 'log'], dp.yScale),
      yLim: limit(src.yLim),
      yTicks: normaliseTicks(src.yTicks, dp.yTicks),
      legend: {
        show: lg.show === undefined || lg.show === null ? null : !!lg.show,
        position: pick(lg.position, LEGEND_POSITIONS, null),
        order: Array.isArray(lg.order) ? lg.order.map(String) : []
      },
      series: []
    };
    panel.series = (Array.isArray(src.series) ? src.series : []).map((q, i) => {
      const n = normaliseSeries(q, ctx, i);
      let id = n.id;
      while (ids.has(id)) id += '_';
      ids.add(id);
      n.id = id;
      return n;
    });
    groupBars(panel.series);
    bracketHeights(panel.series);
    return panel;
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * The person's style over the page's description
 * ------------------------------------------------------------------ */

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

function mergeLook(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : clone(over);
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeLook(out[k], v) : clone(v);
  }
  return out;
}

/**
 * The page's description with the person's style laid over it. The style is
 * partial and holds the look only:
 *
 *   { width, height, …, xLabel, xLim, xTicks, …,     the figure (FIGURE_LOOK)
 *     panels: [{ yLabel, yScale, yLim, yTicks, ratio, legend }],   by index
 *     series: { <id>: { color, label, lineWidth, … } } }           by id
 *
 * Fields the style does not name keep the page's values, so a page can change
 * its data, labels or series and the person's choices stay.
 *
 * @param {object} figure - the page's description (not normalised)
 * @param {object} [style]
 * @returns {object} a description; pass it to normaliseFigure
 */
/*
 * A copy of a description to lay a style over: the figure, its panels and
 * its series are new objects, their look fields copied; the data arrays are
 * shared, not copied (a style never touches them, and they may hold a
 * million points).
 */
function lookCopy(figure) {
  const f = { ...obj(figure) };
  for (const k of FIGURE_LOOK) if (f[k] && typeof f[k] === 'object') f[k] = clone(f[k]);
  if (Array.isArray(f.panels)) {
    f.panels = f.panels.map((p) => {
      const pc = { ...obj(p) };
      for (const k of PANEL_LOOK) if (pc[k] && typeof pc[k] === 'object') pc[k] = clone(pc[k]);
      if (Array.isArray(pc.series)) {
        pc.series = pc.series.map((q) => {
          if (!q || typeof q !== 'object') return q;
          const qc = { ...q };
          for (const k of SERIES_LOOK) if (qc[k] && typeof qc[k] === 'object' && !Array.isArray(qc[k])) qc[k] = clone(qc[k]);
          return qc;
        });
      }
      return pc;
    });
  }
  return f;
}

/* The colour each series takes from the cycle, as normaliseSeries gives it,
   without looking at the data. */
function cycleColours(f) {
  const background = colour(f.background, defaultPlotStyle().background);
  const cycle = colorCycle(background);
  let k = 0;
  return (Array.isArray(f.panels) ? f.panels : []).map((p) => (Array.isArray(p && p.series) ? p.series : []).map((q) => {
    const s = obj(q);
    const kind = pick(s.kind, SERIES_KINDS, 'line');
    const takes = !['hline', 'vline', 'axline', 'text', 'bracket', 'heatmap'].includes(kind) && !(kind === 'contour' && s.filled);
    return takes && !isColour(s.color) ? cycle[k++ % cycle.length] : null;
  }));
}

export function applyStyle(figure, style) {
  const f = lookCopy(figure);
  const s = obj(style);
  for (const k of FIGURE_LOOK) if (s[k] !== undefined) f[k] = mergeLook(f[k], s[k]);
  const panels = Array.isArray(f.panels) && f.panels.length ? f.panels : [{}];
  f.panels = panels;
  if (Array.isArray(s.panels)) {
    s.panels.forEach((ps, i) => {
      if (!panels[i] || !ps) return;
      for (const k of PANEL_LOOK) if (ps[k] !== undefined) panels[i][k] = mergeLook(panels[i][k], ps[k]);
    });
  }
  const bySeries = obj(s.series);
  // The colours the cycle gives are settled first, on the page's series and
  // the figure's background, so that a colour the person sets for one series
  // does not move the others along the cycle.
  const settled = Object.keys(bySeries).length ? cycleColours(f) : null;
  f.panels.forEach((p, pi) => {
    (Array.isArray(p.series) ? p.series : []).forEach((q, i) => {
      if (!q || typeof q !== 'object') return;
      // Every series keeps its place on the cycle, whatever the style recolours.
      const auto = settled && settled[pi] && settled[pi][i];
      if (auto && !isColour(q.color)) q.color = auto;
      const id = q.id !== undefined ? String(q.id) : `${q.kind || 'line'}${i + 1}`;
      const o = bySeries[id];
      if (!o) return;
      for (const k of SERIES_LOOK) if (o[k] !== undefined) q[k] = mergeLook(q[k], o[k]);
    });
  });
  return f;
}

/* The data fields of every kind, emptied by lookOnly. */
const DATA_FIELDS = ['x', 'y', 'z', 'lower', 'upper', 'values', 'counts', 'yerr', 'xerr'];

/**
 * A description with its data left out (every series keeps its kind, id,
 * label and look): what the style panel needs, quick to normalise however
 * many points the figure has.
 */
export function lookOnly(figure) {
  const f = { ...obj(figure) };
  if (Array.isArray(f.panels)) {
    f.panels = f.panels.map((p) => ({
      ...obj(p),
      series: (Array.isArray(p && p.series) ? p.series : []).map((q) => {
        if (!q || typeof q !== 'object') return q;
        const qc = { ...q };
        for (const k of DATA_FIELDS) if (qc[k] !== undefined && qc[k] !== null) qc[k] = k === 'z' ? [] : [];
        if (Array.isArray(qc.groups)) qc.groups = [];
        return qc;
      })
    }));
  }
  return f;
}

/* ------------------------------------------------------------------ *
 * Backgrounds: white, transparent, dark or a colour of one's own
 * ------------------------------------------------------------------ */

/** The two looks the background picker switches between, and their inks. */
export const BACKGROUNDS = Object.freeze({
  white: Object.freeze({ background: '#ffffff', foreground: '#1a1a1a', grid: '#b0b0b0' }),
  dark: Object.freeze({ background: '#0f172a', foreground: '#e2e8f0', grid: '#64748b' })
});

/* WCAG contrast of two '#rrggbb' colours. */
function contrast(a, b) {
  const la = luminance(a); const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ink (text and lines) that reads best on a background: dark or light. */
export function readableInk(background) {
  return contrast(background, BACKGROUNDS.white.foreground) >= contrast(background, BACKGROUNDS.dark.foreground)
    ? BACKGROUNDS.white.foreground : BACKGROUNDS.dark.foreground;
}

/**
 * Which of the picker's four a figure's look is: 'transparent' (export
 * transparent, whatever the colours), 'white', 'dark', or 'custom'; with the
 * ink ('dark' or 'light') a transparent figure is drawn in.
 */
export function backgroundChoice(look) {
  const l = obj(look);
  const bg = colour(l.background, BACKGROUNDS.white.background);
  const fg = colour(l.foreground, BACKGROUNDS.white.foreground);
  const ink = luminance(fg) > 0.5 ? 'light' : 'dark';
  if (l.export && l.export.transparent) return { choice: 'transparent', ink };
  if (bg === BACKGROUNDS.white.background && fg === BACKGROUNDS.white.foreground) return { choice: 'white', ink };
  if (bg === BACKGROUNDS.dark.background && fg === BACKGROUNDS.dark.foreground) return { choice: 'dark', ink };
  return { choice: 'custom', ink };
}

/**
 * The person's style with one of the picker's backgrounds chosen, from any
 * other: white and dark set the background, the text and lines, the grid's
 * colour and whether the page is transparent; transparent keeps the page
 * clear in the preview and every export, drawn in dark ink (for light slides
 * and pages) or light ink (for dark slides); custom sets a background (and,
 * unless given, the ink that reads on it). Series whose colour is one of the
 * default cycle's move to the same hue for the ground they now stand on, and
 * back, so White after Dark is White again.
 *
 * @param {object} style - the person's style (partial)
 * @param {object} figure - the page's description (for its series' own colours)
 * @param {'white'|'dark'|'transparent'|'custom'} choice
 * @param {{ink?: 'dark'|'light', background?: string, foreground?: string}} [opts]
 * @returns {object} the new style
 */
export function withBackground(style, figure, choice, opts = {}) {
  const s = clone(obj(style)) || {};
  const set = (bg, fg, grid, transparent) => {
    s.background = bg;
    s.foreground = fg;
    s.grid = { ...obj(s.grid), color: grid };
    s.export = { ...obj(s.export), transparent };
  };
  let ground;
  if (choice === 'white' || choice === 'dark') {
    const b = BACKGROUNDS[choice];
    set(b.background, b.foreground, b.grid, false);
    ground = choice;
  } else if (choice === 'transparent') {
    const b = BACKGROUNDS[opts.ink === 'light' ? 'dark' : 'white'];
    // The background stays behind a transparent page for what shows it (the
    // legend's box): the ground the ink is meant for.
    set(b.background, b.foreground, b.grid, true);
    ground = opts.ink === 'light' ? 'dark' : 'white';
  } else {
    const bg = colour(opts.background, colour(s.background, BACKGROUNDS.white.background));
    const fg = colour(opts.foreground, readableInk(bg));
    s.background = bg;
    s.foreground = fg;
    s.export = { ...obj(s.export), transparent: false };
    ground = luminance(bg) < 0.2 ? 'dark' : 'white';
  }
  return ownValuesDropped(recolourSeries(s, figure, ground === 'dark'), figure);
}

/* What a background choice set that the page's description already has is
   left out of the style, so that White on a white page is no style at all. */
function ownValuesDropped(style, figure) {
  const own = normaliseFigure(lookOnly(obj(figure)));
  const out = { ...style };
  if (out.background === own.background) delete out.background;
  if (out.foreground === own.foreground) delete out.foreground;
  for (const [key, field] of [['grid', 'color'], ['export', 'transparent']]) {
    if (!out[key] || typeof out[key] !== 'object') continue;
    const o = { ...out[key] };
    if (o[field] === own[key][field]) delete o[field];
    if (Object.keys(o).length) out[key] = o; else delete out[key];
  }
  return out;
}

/* Series of the default cycle on the ground they stand on: a person's
   colour of the other cycle moves to the same hue; one that returns to the
   page's own colour is dropped from the style. */
function recolourSeries(style, figure, dark) {
  const from = dark ? COLOR_CYCLE : COLOR_CYCLE_DARK;
  const to = dark ? COLOR_CYCLE_DARK : COLOR_CYCLE;
  const own = new Map();
  (Array.isArray(obj(figure).panels) ? figure.panels : []).forEach((p) => (Array.isArray(p && p.series) ? p.series : []).forEach((q, i) => {
    if (q && typeof q === 'object') own.set(q.id !== undefined ? String(q.id) : `${q.kind || 'line'}${i + 1}`, q);
  }));
  const series = { ...obj(style.series) };
  for (const [id, q] of own) {
    const o = { ...obj(series[id]) };
    for (const key of ['color', 'edgeColor']) {
      const current = colour(o[key], colour(q[key], null));
      if (!current) continue;   // left to the cycle: it follows the ground by itself
      const k = from.indexOf(current);
      if (k < 0) continue;
      const next = to[k];
      if (colour(q[key], null) === next) delete o[key]; else o[key] = next;
    }
    if (Object.keys(o).length) series[id] = o; else delete series[id];
  }
  const out = { ...style, series };
  if (!Object.keys(series).length) delete out.series;
  return out;
}

/** Keys of the look, for the style panel and for checking a stored style. */
export const LOOK_KEYS = Object.freeze({ figure: FIGURE_LOOK, panel: PANEL_LOOK, series: SERIES_LOOK });

/**
 * A stored style with anything that is not look left out (so an old or
 * hand-edited style cannot carry data into the figure).
 */
export function cleanStyle(style) {
  const s = obj(style);
  const out = {};
  for (const k of FIGURE_LOOK) if (s[k] !== undefined) out[k] = clone(s[k]);
  if (Array.isArray(s.panels)) {
    out.panels = s.panels.map((p) => {
      const o = {};
      for (const k of PANEL_LOOK) if (p && p[k] !== undefined) o[k] = clone(p[k]);
      return o;
    });
  }
  if (s.series && typeof s.series === 'object') {
    out.series = {};
    for (const [id, v] of Object.entries(s.series)) {
      const o = {};
      for (const k of SERIES_LOOK) if (v && v[k] !== undefined) o[k] = clone(v[k]);
      if (Object.keys(o).length) out.series[id] = o;
    }
  }
  return out;
}
