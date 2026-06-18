# Blog Review Image Acceptance Policy

This policy is for the hourly `Daily OliveYoung AI blog posts` automation.

## Accepted Manual-Review Image Level

Manual-review posts may pass with product-specific reconstructed review images. They do not need to be perfect AI photorealism if all of these are true:

- The images are based on real OliveYoung source/detail/gallery images for the exact product.
- The same product family is visible across all 18 review images.
- The product identity is preserved through physical cues: package color, container shape, label blocks, option/refill/gift relationship, texture/applicator/puff/dropper/brush where relevant.
- The scene reads as a Korean review-style arrangement: towel, sink tray, vanity, pouch, hand-held scale, memo, tray, brush/comb, refill, swatch, texture, or opened package.
- The assets are PNG files named `<slug>-detail-page-01.png` and `<slug>-review-01.png` through `<slug>-review-18.png`.
- The post has `reviewAssetVersion === "20260611-manual-review"`.
- `scripts/blog-product-profiles.js` has an exact slug profile with 18 captions that match the numbered images.
- `node scripts/verify-manual-review-post.js --slug <slug> --contact-sheet` passes.

## Do Not Reject Solely Because

- The product is visibly composited from official product cutouts.
- Lighting or shadows are slightly synthetic.
- The layout is cleaner than a real phone photo.
- Official label text is approximate but the product family, container, color, and option relationship are clear.

That level is acceptable for this automation. The purpose is a hand-made review-photo style, not forensic product photography.

## Still Reject

Reject and repair before publishing if any of these are true:

- Wrong product, wrong category, or mixed product families.
- Raw OliveYoung screenshot/detail banner used directly as a review image.
- Repeated identical packshot with no scene variation.
- Blank, broken, tiny, or heavily cropped images.
- Celebrity/model/ad campaign image used as a review photo.
- Discount badges, sale typography, or floating promo layout dominates the image.
- Captions do not match the numbered image.
- Review gallery uses JPG assets for a manual-review post.

## Verification Sequence

After creating the manual profile and images:

```bash
node --check scripts/build-blog-pages.js
node --check scripts/blog-product-profiles.js
node --check scripts/verify-manual-review-post.js
node scripts/build-blog-pages.js --refresh-existing-only --only-slug <slug>
node scripts/verify-manual-review-post.js --slug <slug> --contact-sheet
```

Then run the browser/static render check required by the automation prompt.
